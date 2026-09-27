import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createMediaAssetFromUpload,
  deleteUnusedMediaAsset,
  assetMatchesLayerType,
  filterAndSortMedia,
  formatDimensions,
  formatDuration,
  formatFileSize,
  layerPlaybackUrl,
  layerWithMediaAsset,
  mediaAspectRatio,
  mediaDimensionChange,
  mediaUsageCounts,
} from '../src/media/mediaLibraryUtils.ts'
import { newImageLayerSize } from '../src/lib/wallGeometry.ts'

function asset(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Lobby image',
    original_filename: 'lobby-final.png',
    object_key: 'media/12345678-1234-4234-8234-123456789abc/lobby-final.png',
    public_url: 'https://media.example.com/media/12345678-1234-4234-8234-123456789abc/lobby-final.png',
    mime_type: 'image/png',
    media_type: 'image',
    size_bytes: 416000,
    width: 1920,
    height: 1080,
    duration_seconds: null,
    thumbnail_object_key: null,
    thumbnail_url: null,
    created_at: '2026-09-27T12:00:00.000Z',
    created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ...overrides,
  }
}

function layer(type = 'image', content = {}) {
  return { id: 'layer', type, target: [], x: 0, y: 0, width: 100, height: 100, zIndex: 1, content }
}

test('media picker compatibility keeps image and video assets in their matching layers', () => {
  assert.equal(assetMatchesLayerType(asset(), 'image'), true)
  assert.equal(assetMatchesLayerType(asset(), 'video'), false)
  assert.equal(assetMatchesLayerType(asset({ media_type: 'video', mime_type: 'video/mp4' }), 'video'), true)
})

test('media search, filter, and sorting use names and original filenames', () => {
  const assets = [
    asset(),
    asset({ id: '2', name: 'Welcome reel', original_filename: 'opening-night.mp4', media_type: 'video', mime_type: 'video/mp4', created_at: '2026-09-28T12:00:00.000Z' }),
  ]
  assert.deepEqual(filterAndSortMedia(assets, 'opening', 'all', 'newest').map(item => item.id), ['2'])
  assert.deepEqual(filterAndSortMedia(assets, '', 'image', 'newest').map(item => item.id), [assets[0].id])
  assert.deepEqual(filterAndSortMedia(assets, '', 'all', 'oldest').map(item => item.id), [assets[0].id, '2'])
  assert.deepEqual(filterAndSortMedia(assets, '', 'all', 'name').map(item => item.name), ['Lobby image', 'Welcome reel'])
})

test('media metadata formatting is friendly without altering stored values', () => {
  assert.equal(formatFileSize(416000), '406 KB')
  assert.equal(formatFileSize(13_000_000), '12.4 MB')
  assert.equal(formatDimensions(1920, 1080), '1920 × 1080')
  assert.equal(formatDuration(42.2), '00:42')
  assert.equal(formatDuration(3723), '1:02:03')
})

test('usage count counts distinct scenes, not duplicate layers', () => {
  const id = asset().id
  const counts = mediaUsageCounts([
    { id: 'scene-a', layers: [layer('image', { mediaAssetId: id }), layer('image', { mediaAssetId: id })] },
    { id: 'scene-b', layers: [layer('image', { mediaAssetId: id })] },
    { id: 'scene-c', layers: [layer('image', { url: 'https://legacy.example/image.png' })] },
  ])
  assert.equal(counts.get(id), 2)
})

test('selecting an asset writes both durable id and playback URL plus source metadata', () => {
  const selected = layerWithMediaAsset(layer(), asset())
  assert.equal(selected.content.mediaAssetId, asset().id)
  assert.equal(selected.content.url, asset().public_url)
  assert.equal(selected.sourceWidth, 1920)
  assert.equal(selected.sourceHeight, 1080)
  assert.equal(selected.aspectRatio, 16 / 9)
  assert.throws(() => layerWithMediaAsset(layer('video'), asset()), /cannot be used/)
})

test('a new V1 image layer preserves wall width and derives wall height from source aspect ratio', () => {
  const source = asset({ width: 413, height: 325 })
  const selected = layerWithMediaAsset({ ...layer('image', {}), width: 45, height: 45 }, source, 'match-aspect')
  assert.equal(selected.width, 45)
  assert.ok(Math.abs(selected.height - 35.41162227602906) < 1e-10)
  assert.equal(selected.content.mediaAssetId, asset().id)
  assert.equal(selected.content.url, asset().public_url)
  assert.equal(selected.sourceWidth, 413)
  assert.equal(selected.sourceHeight, 325)
  assert.equal(selected.aspectRatio, 413 / 325)
  assert.notEqual(selected.width, source.width)
  assert.notEqual(selected.height, source.height)
})

test('media aspect ratio and locked dimension edits use width divided by height', () => {
  const ratio = mediaAspectRatio(413, 325)
  assert.ok(ratio > 1)
  assert.equal(ratio, 413 / 325)
  const layerGeometry = { width: 45, height: 45, lockedAspect: true, aspectRatio: ratio }
  const widthChange = mediaDimensionChange(layerGeometry, 'width', 44)
  assert.equal(widthChange.width, 44)
  assert.ok(Math.abs(widthChange.height - 44 / (413 / 325)) < 1e-10)
  assert.ok(widthChange.height < widthChange.width)
  const heightChange = mediaDimensionChange(layerGeometry, 'height', 30)
  assert.equal(heightChange.height, 30)
  assert.ok(Math.abs(heightChange.width - 30 * (413 / 325)) < 1e-10)
  assert.ok(heightChange.width > heightChange.height)
})

test('unlocked dimensions change independently and invalid locked values are ignored', () => {
  const layerGeometry = { width: 37, height: 24, lockedAspect: false, aspectRatio: 413 / 325 }
  assert.deepEqual(mediaDimensionChange(layerGeometry, 'width', 40), { width: 40 })
  assert.deepEqual(mediaDimensionChange(layerGeometry, 'height', 20), { height: 20 })
  assert.deepEqual(mediaDimensionChange({ ...layerGeometry, lockedAspect: true }, 'width', Number.NaN), {})
  assert.deepEqual(mediaDimensionChange({ ...layerGeometry, lockedAspect: true }, 'height', 0), {})
})

test('new image default uses a modest fraction of the current wall width', () => {
  const size = newImageLayerSize({ width: 1920 })
  assert.equal(size.width, 5)
  assert.equal(size.height, 5 / (16 / 9))
  assert.ok(size.width < 45)
  assert.ok(size.height < 45)
})

test('an existing resized image layer keeps its dimensions when its asset changes', () => {
  const selected = layerWithMediaAsset({ ...layer('image', {}), width: 37, height: 24 }, asset(), 'preserve')
  assert.equal(selected.width, 37)
  assert.equal(selected.height, 24)
  assert.equal(selected.sourceWidth, 1920)
  assert.equal(selected.sourceHeight, 1080)
})

test('asset assignment preserves every saved fit mode', () => {
  for (const fit of ['cover', 'contain', 'custom']) {
    const selected = layerWithMediaAsset({ ...layer('image', { fit }), width: 37, height: 24 }, asset(), 'preserve')
    assert.equal(selected.content.fit, fit)
  }
})

test('new V2 media uses intrinsic virtual-pixel geometry for library and upload assignment', () => {
  const image = asset({ width: 413, height: 325 })
  const video = asset({ media_type: 'video', mime_type: 'video/mp4', width: 1920, height: 1080, duration_seconds: 12 })
  const placeholder = { ...layer('image', {}), width: 45, height: 45, x: 100, y: 200, lockedAspect: true }
  const librarySelection = layerWithMediaAsset(placeholder, image, 'intrinsic')
  const uploadSelection = layerWithMediaAsset({ ...placeholder, type: 'video' }, video, 'intrinsic')
  assert.deepEqual({ width: librarySelection.width, height: librarySelection.height, sourceWidth: librarySelection.sourceWidth, sourceHeight: librarySelection.sourceHeight, aspectRatio: librarySelection.aspectRatio }, { width: 413, height: 325, sourceWidth: 413, sourceHeight: 325, aspectRatio: 413 / 325 })
  assert.deepEqual({ width: uploadSelection.width, height: uploadSelection.height, sourceWidth: uploadSelection.sourceWidth, sourceHeight: uploadSelection.sourceHeight, aspectRatio: uploadSelection.aspectRatio }, { width: 1920, height: 1080, sourceWidth: 1920, sourceHeight: 1080, aspectRatio: 16 / 9 })
  assert.deepEqual({ x: librarySelection.x, y: librarySelection.y }, { x: 100, y: 200 })
})

test('new V2 media does not fit large intrinsic assets to the current wall', () => {
  const large = asset({ width: 3840, height: 2160 })
  const selected = layerWithMediaAsset({ ...layer('image', {}), width: 500, height: 300 }, large, 'intrinsic')
  assert.deepEqual({ width: selected.width, height: selected.height }, { width: 3840, height: 2160 })
})

test('successful upload builds and inserts the complete media_assets row', async () => {
  const file = new File(['video'], 'Lobby Loop.mp4', { type: 'video/mp4' })
  let inserted
  const created = await createMediaAssetFromUpload(file, asset().created_by, {
    async readMetadata() { return { width: 1920, height: 1080, durationSeconds: 42.25 } },
    async authorize() { return { uploadUrl: 'https://signed.example', objectKey: 'media/12345678-1234-4234-8234-123456789abc/Lobby-Loop.mp4', publicUrl: 'https://media.example.com/media/12345678-1234-4234-8234-123456789abc/Lobby-Loop.mp4' } },
    async upload() {},
    async insert(row) { inserted = row; return asset({ ...row, id: 'video-id', created_at: '2026-09-29T00:00:00.000Z' }) },
    async cleanup() { assert.fail('cleanup should not run after a successful insert') },
  })
  assert.equal(inserted.name, 'Lobby Loop')
  assert.equal(inserted.original_filename, 'Lobby Loop.mp4')
  assert.equal(inserted.media_type, 'video')
  assert.equal(inserted.size_bytes, 5)
  assert.equal(inserted.width, 1920)
  assert.equal(inserted.height, 1080)
  assert.equal(inserted.duration_seconds, 42.25)
  assert.equal(inserted.created_by, asset().created_by)
  assert.equal(created.id, 'video-id')
})

test('metadata insert failure cleans up the uploaded R2 object and reports the rollback', async () => {
  const calls = []
  const file = new File(['image'], 'lobby.png', { type: 'image/png' })
  await assert.rejects(createMediaAssetFromUpload(file, asset().created_by, {
    async readMetadata() { return { width: 100, height: 50, durationSeconds: null } },
    async authorize() { return { uploadUrl: 'https://signed.example', objectKey: asset().object_key, publicUrl: asset().public_url } },
    async upload() { calls.push('upload') },
    async insert() { calls.push('insert'); throw new Error('database unavailable') },
    async cleanup(key) { calls.push(`cleanup:${key}`) },
  }), /uploaded R2 object was cleaned up/)
  assert.deepEqual(calls, ['upload', 'insert', `cleanup:${asset().object_key}`])
})

test('failed rollback clearly reports a possible orphaned object', async () => {
  const file = new File(['image'], 'lobby.png', { type: 'image/png' })
  await assert.rejects(createMediaAssetFromUpload(file, asset().created_by, {
    async readMetadata() { return { width: 100, height: 50, durationSeconds: null } },
    async authorize() { return { uploadUrl: 'https://signed.example', objectKey: asset().object_key, publicUrl: asset().public_url } },
    async upload() {},
    async insert() { throw new Error('insert failed') },
    async cleanup() { throw new Error('delete failed') },
  }), /orphaned object may remain/)
})

test('used assets cannot be deleted and unused assets delete object before metadata', async () => {
  const calls = []
  const actions = { async deleteObject() { calls.push('object') }, async deleteMetadata() { calls.push('metadata') } }
  await assert.rejects(deleteUnusedMediaAsset(asset(), 2, actions), /used in 2 scenes/)
  assert.deepEqual(calls, [])
  await deleteUnusedMediaAsset(asset(), 0, actions)
  assert.deepEqual(calls, ['object', 'metadata'])
})

test('legacy URL-only layers still resolve directly without a media asset lookup', () => {
  const url = 'https://legacy.supabase.co/storage/v1/object/public/media/old.png'
  assert.equal(layerPlaybackUrl(layer('image', { url })), url)
})

test('temporary MEDIA-01A.1 developer panel and helper are removed', () => {
  assert.equal(existsSync(new URL('../src/admin/R2UploadTestPanel.tsx', import.meta.url)), false)
  assert.equal(existsSync(new URL('../src/lib/manualR2Upload.ts', import.meta.url)), false)
  assert.doesNotMatch(readFileSync(new URL('../src/admin/Admin.tsx', import.meta.url), 'utf8'), /Test R2 upload|R2UploadTestPanel/)
})
