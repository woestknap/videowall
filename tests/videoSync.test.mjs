import assert from 'node:assert/strict'
import test from 'node:test'
import { VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS, VIDEO_SYNC_INTERVAL_MS, videoSyncDecision, wrappedVideoDrift } from '../src/lib/videoSync.ts'

test('small drift returns exactly to normal playback', () => {
  assert.deepEqual(videoSyncDecision(.1, 10_000, null), { playbackRate: 1, hardSeek: false })
  assert.deepEqual(videoSyncDecision(-.08, 10_000, null), { playbackRate: 1, hardSeek: false })
})

test('moderate positive and negative drift use bounded rate correction', () => {
  const ahead = videoSyncDecision(.4, 10_000, null)
  const behind = videoSyncDecision(-.75, 10_000, null)
  assert.equal(ahead.hardSeek, false)
  assert.ok(ahead.playbackRate > 1 && ahead.playbackRate <= 1.03)
  assert.equal(behind.hardSeek, false)
  assert.ok(behind.playbackRate < 1 && behind.playbackRate >= .95)
})

test('large drift hard seeks only outside the cooldown', () => {
  assert.equal(videoSyncDecision(1.01, 10_000, null).hardSeek, true)
  const cooled = videoSyncDecision(1.5, 10_000 + VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS - 1, 10_000)
  assert.deepEqual(cooled, { playbackRate: 1.05, hardSeek: false })
  assert.equal(videoSyncDecision(-1.01, 10_000 + VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS, 10_000).hardSeek, true)
})

test('loop boundaries use the short wrapped drift rather than a false desync', () => {
  assert.ok(Math.abs(wrappedVideoDrift(.05, 9.95, 10, true) - .1) < 1e-9)
  assert.ok(Math.abs(wrappedVideoDrift(9.95, .05, 10, true) + .1) < 1e-9)
})

test('sync interval remains lightweight and raw-video bypass stays separate', async () => {
  assert.equal(VIDEO_SYNC_INTERVAL_MS, 600)
  const layer = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/rendering/Layer.tsx', import.meta.url), 'utf8'))
  const syncedVideo = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/rendering/SyncedVideo.tsx', import.meta.url), 'utf8'))
  assert.match(layer, /rawVideo \? <video/)
  assert.match(layer, /: <SyncedVideo/)
  assert.match(syncedVideo, /video\.currentTime = expectedPosition\(\)/)
})
