import assert from 'node:assert/strict'
import test from 'node:test'
import { VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS, VIDEO_SYNC_INTERVAL_MS, videoSyncDecision, wrappedVideoDrift } from '../src/lib/videoSync.ts'

test('drift through 60ms returns exactly to normal playback', () => {
  assert.deepEqual(videoSyncDecision(.06, 10_000, null), { playbackRate: 1, hardSeek: false, band: 'SYNCED' })
  assert.deepEqual(videoSyncDecision(-.04, 10_000, null), { playbackRate: 1, hardSeek: false, band: 'SYNCED' })
})

test('60-300ms drift uses smooth, bounded gentle correction in both directions', () => {
  const ahead = videoSyncDecision(.2, 10_000, null)
  const behind = videoSyncDecision(-.3, 10_000, null)
  assert.equal(ahead.hardSeek, false)
  assert.equal(ahead.band, 'GENTLE')
  assert.ok(ahead.playbackRate > 1 && ahead.playbackRate < 1.02)
  assert.equal(behind.hardSeek, false)
  assert.equal(behind.band, 'GENTLE')
  assert.equal(behind.playbackRate, .98)
})

test('300-700ms drift progressively ramps to the stronger rate limit', () => {
  const mid = videoSyncDecision(.5, 10_000, null)
  const limit = videoSyncDecision(-.7, 10_000, null)
  assert.equal(mid.band, 'STRONG')
  assert.ok(mid.playbackRate > 1.02 && mid.playbackRate < 1.06)
  assert.deepEqual(limit, { playbackRate: .94, hardSeek: false, band: 'STRONG' })
})

test('large drift hard seeks only outside the cooldown', () => {
  assert.equal(videoSyncDecision(.96, 10_000, null).hardSeek, true)
  const cooled = videoSyncDecision(1.5, 10_000 + VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS - 1, 10_000)
  assert.deepEqual(cooled, { playbackRate: 1.06, hardSeek: false, band: 'RECOVERY' })
  assert.equal(videoSyncDecision(-.96, 10_000 + VIDEO_SYNC_HARD_SEEK_COOLDOWN_MS, 10_000).hardSeek, true)
})

test('loop boundaries use the short wrapped drift rather than a false desync', () => {
  assert.ok(Math.abs(wrappedVideoDrift(.05, 9.95, 10, true) - .1) < 1e-9)
  assert.ok(Math.abs(wrappedVideoDrift(9.95, .05, 10, true) + .1) < 1e-9)
})

test('sync interval remains lightweight and raw-video bypass stays separate', async () => {
  assert.equal(VIDEO_SYNC_INTERVAL_MS, 500)
  const layer = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/rendering/Layer.tsx', import.meta.url), 'utf8'))
  const syncedVideo = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/rendering/SyncedVideo.tsx', import.meta.url), 'utf8'))
  assert.match(layer, /rawVideo \? <video/)
  assert.match(layer, /: <SyncedVideo/)
  assert.match(syncedVideo, /video\.currentTime = expectedPosition\(\)/)
})
