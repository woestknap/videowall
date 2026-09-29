import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { geometryDebugRows, liveDebugRows, mediaDebugRows, playerHealthSummary, playlistDebugRows, shortDebugId } from '../src/player/playerDebug.ts'

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
test('live-source diagnostics report close details without exposing sensitive signaling data', () => {
  const rows = liveDebugRows([{ ...v2.layers[0], content: { liveSourceId: 'camera-source-id', liveSourceName: 'Camera A' } }], ['camera-source-id'], { 'camera-source-id': 'RECONNECTING' }, new Map(), {
    'camera-source-id': { socketState: 'CLOSED', closeCode: 1008, closeReason: 'replaced', closeWasClean: true, socketError: true, sessionId: 'session-123456789', generation: 2, targetDeviceId: 'target-123456789', expiresAt: '2026-09-29T12:00:00.000Z', peerConnectionState: 'failed', iceConnectionState: 'disconnected', deviceToken: 'secret-token', sdp: 'secret-sdp', candidate: 'secret-candidate' },
  })
  const detail = rows[0].detail ?? ''
  assert.match(detail, /ws=CLOSED/)
  assert.match(detail, /close=1008 clean \(replaced\)/)
  assert.match(detail, /ws-error/)
  assert.match(detail, /session=session-/)
  assert.match(detail, /generation=2/)
  assert.match(detail, /target=target-1/)
  assert.match(detail, /expires=2026-09-29T12:00:00.000Z/)
  assert.match(detail, /peer=failed/)
  assert.match(detail, /ice=disconnected/)
  assert.doesNotMatch(detail, /secret-token|secret-sdp|secret-candidate/)
})
test('media states remain compact and debug-disabled player rendering does not subscribe to them', () => {
  assert.equal(mediaDebugRows([{ ...v2.layers[0], id: 'video', type: 'video' }], { video: 'PLAYING' }).find(row => row.label === 'Video video')?.value, 'PLAYING')
  const player = readFileSync(new URL('../src/player/Player.tsx', import.meta.url), 'utf8')
  assert.match(player, /onMediaStateChange=\{debug \? setMediaStatus : undefined\}/)
  assert.match(player, /onStatus=\{debug \? setLiveSourceStatus : ignoreLiveSourceStatus\}/)
})
test('playlist diagnostics expose display and preparation state without secrets', () => {
  const runtime = { playlist_name: 'Morning', status: 'PLAYING', phase: 'PREPARING', generation: '123456789012', sequence: 4, current_index: 0, item_count: 5, target_scene_id: 'target-scene', target_scene_name: 'Promo', ready_count: 4, expected_count: 5, transition_deadline_at: new Date(Date.now() + 5000).toISOString(), failed_device_ids: [], degraded: false }
  const rows = playlistDebugRows(runtime)
  assert.equal(rows.find(row => row.label === 'Playlist')?.value, 'Morning')
  assert.equal(rows.find(row => row.label === 'Ready')?.value, '4 / 5')
  assert.equal(rows.find(row => row.label === 'Generation')?.value, '12345678…')
  assert.equal(rows.some(row => row.label.toLowerCase().includes('token')), false)
})
