import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { geometryDebugRows, liveDebugRows, mediaDebugRows, playerHealthSummary, shortDebugId } from '../src/player/playerDebug.ts'

const v1 = { id: 'scene', name: 'Legacy', layers: [], duration_seconds: 1 }
const v2 = { ...v1, geometry_version: 2, canvas_width_px: 3362, canvas_height_px: 1831, wall_geometry_revision: 'current', layers: [{ id: 'live-layer', type: 'live', target: [], x: 0, y: 0, width: 1, height: 1, zIndex: 1, content: { liveSourceId: 'camera-a', liveSourceName: 'Camera A' } }] }
const validContract = { status: 'valid', canvas: { x: 0, y: 0, width: 3362, height: 1831 }, region: { x: 0, y: 0, width: 800, height: 480 } }
const wall = { status: 'valid', layoutMode: 'resolution', widthPx: 3362, heightPx: 1831, geometryRevision: 'current', virtualPixelsPerMm: null, devices: [{ deviceId: 'pi', xPx: 0, yPx: 0, widthPx: 800, heightPx: 480, viewportWidthPx: 800, viewportHeightPx: 480 }] }

test('V1 debug summary omits V2-only fields', () => {
  assert.deepEqual(geometryDebugRows(v1, null, null, undefined, { width: 800, height: 480 }).map(row => row.label), ['Geometry', 'Viewport'])
})
test('valid V2 debug summary includes canvas, region, and matched revision', () => {
  const rows = geometryDebugRows(v2, wall, validContract, wall.devices[0], { width: 800, height: 480 })
  assert.equal(rows.find(row => row.label === 'Geometry')?.value, 'V2 OK')
  assert.equal(rows.find(row => row.label === 'Revision')?.value, 'MATCHED')
  assert.match(rows.find(row => row.label === 'Region')?.value ?? '', /w=800/)
})
test('V2 revision mismatch is explicit', () => {
  const rows = geometryDebugRows(v2, { ...wall, geometryRevision: 'new' }, { status: 'invalid', reason: 'wall-geometry-revision-mismatch' }, undefined, { width: 1, height: 1 })
  assert.equal(rows.find(row => row.label === 'Revision')?.value, 'MISMATCH')
  assert.equal(playerHealthSummary({ scene: v2, contract: { status: 'invalid', reason: 'wall-geometry-revision-mismatch' }, status: 'Connected', signaling: 'idle' }), 'GEOMETRY ERROR')
})
test('IDs, missing values, and multiple live rows remain safe and distinct', () => {
  assert.equal(shortDebugId('123456789012'), '12345678…')
  assert.equal(shortDebugId(null), '—')
  const rows = liveDebugRows([{ ...v2.layers[0], content: { liveSourceId: 'a', liveSourceName: 'Camera A' } }, { ...v2.layers[0], id: 'other', content: { liveSourceId: 'b' } }], ['a', 'b'], { a: 'STREAMING', b: 'WAITING' }, new Map())
  assert.deepEqual(rows.map(row => row.value), ['STREAMING', 'WAITING'])
})
test('media states remain compact and debug-disabled player rendering does not subscribe to them', () => {
  assert.equal(mediaDebugRows([{ ...v2.layers[0], id: 'video', type: 'video' }], { video: 'PLAYING' }).find(row => row.label === 'Video video')?.value, 'PLAYING')
  const player = readFileSync(new URL('../src/player/Player.tsx', import.meta.url), 'utf8')
  assert.match(player, /onMediaStateChange=\{debug \? setMediaStatus : undefined\}/)
  assert.match(player, /onStatus=\{debug \? setLiveSourceStatus : ignoreLiveSourceStatus\}/)
})
