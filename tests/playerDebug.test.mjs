import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { geometryDebugRows, liveDebugRows, mediaDebugRows, mergeLiveSourceDiagnostic, playerHealthSummary, playlistDebugRows, shortDebugId } from '../src/player/playerDebug.ts'

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
    'camera-source-id': { socketState: 'OPEN', lastCloseCode: 1008, lastCloseReason: 'replaced', lastCloseWasClean: true, lastCloseAtMs: Date.now() - 8_000, socketError: false, sessionId: 'session-123456789', generation: 2, targetDeviceId: 'target-123456789', expiresAt: '2026-09-29T12:00:00.000Z', peerConnectionState: 'failed', iceConnectionState: 'disconnected', receiverStats: { inboundMbps: 2.4, receiveFps: 30, framesDecoded: 29, framesDropped: 2, packetLossPercent: .2, jitterMs: 14, roundTripTimeMs: 23, candidateType: 'host', inboundVideoStatsAvailable: false, statsEntries: 12, videoReceivers: 1 }, deviceToken: 'secret-token', sdp: 'secret-sdp', candidate: 'secret-candidate' },
  })
  const detail = rows[0].detail ?? ''
  assert.match(detail, /ws=OPEN/)
  assert.match(detail, /last-close=1008 clean \(replaced\) [0-9]+s ago/)
  assert.match(detail, /session=session-/)
  assert.match(detail, /generation=2/)
  assert.match(detail, /target=target-1/)
  assert.match(detail, /expires=2026-09-29T12:00:00.000Z/)
  assert.match(detail, /peer=failed/)
  assert.match(detail, /ice=disconnected/)
  assert.match(detail, /in=2.4Mbps.*recv=30.0fps.*loss=0.2%.*jitter=14.0ms.*rtt=23.0ms/)
  assert.match(detail, /receiver-stats=unavailable.*stats-entries=12.*video-receivers=1/)
  assert.doesNotMatch(detail, /secret-token|secret-sdp|secret-candidate/)
})
test('recovered sockets retain close history until a genuinely new session starts', () => {
  const closed = { sessionId: 'session-a', lastCloseCode: 1006, lastCloseReason: '', lastCloseWasClean: false, lastCloseAtMs: 100 }
  const recovered = mergeLiveSourceDiagnostic(closed, { sessionId: 'session-a', socketState: 'OPEN', socketError: false })
  assert.equal(recovered.lastCloseCode, 1006)
  assert.equal(recovered.socketState, 'OPEN')
  const replacement = mergeLiveSourceDiagnostic(recovered, { sessionId: 'session-b', socketState: 'CONNECTING' })
  assert.equal(replacement.lastCloseCode, undefined)
  assert.equal(replacement.socketState, 'CONNECTING')
})
test('media states remain compact and debug-disabled player rendering does not subscribe to them', () => {
  assert.equal(mediaDebugRows([{ ...v2.layers[0], id: 'video', type: 'video' }], { video: 'PLAYING' }).find(row => row.label === 'Video video')?.value, 'PLAYING')
  const player = readFileSync(new URL('../src/player/Player.tsx', import.meta.url), 'utf8')
  assert.match(player, /onMediaStateChange=\{debug \? setMediaStatus : undefined\}/)
  assert.match(player, /onStatus=\{debug \? setLiveSourceStatus : ignoreLiveSourceStatus\}/)
})
test('playlist diagnostics expose display, loader, and activation state without secrets', () => {
  const runtime = { playlist_name: 'Morning', status: 'PLAYING', phase: 'PREPARING', generation: '123456789012', sequence: 4, current_index: 0, item_count: 5, target_scene_id: 'target-scene', target_scene_name: 'Promo', loading_scene_id: 'loading-scene', loading_at: new Date(Date.now() + 600).toISOString(), activation_at: null, ready_count: 4, expected_count: 5, transition_deadline_at: new Date(Date.now() + 5000).toISOString(), failed_device_ids: [], degraded: false }
  const rows = playlistDebugRows(runtime, Date.now(), { loaderSkewMs: 23, activationSkewMs: -8, clockRoundTripMs: 17.4, pollRoundTripMs: 42.2 })
  assert.equal(rows.find(row => row.label === 'Playlist')?.value, 'Morning')
  assert.equal(rows.find(row => row.label === 'Ready')?.value, '4 / 5')
  assert.equal(rows.find(row => row.label === 'Generation')?.value, '12345678…')
  assert.match(rows.find(row => row.label === 'Loader')?.value ?? '', /^IN 00:0[01]\.[0-9]$/)
  assert.equal(rows.find(row => row.label === 'Loader skew')?.value, '+23 ms')
  assert.equal(rows.find(row => row.label === 'Activation skew')?.value, '-8 ms')
  assert.equal(rows.find(row => row.label === 'Clock RTT')?.value, '17 ms')
  assert.equal(rows.find(row => row.label === 'Poll RTT')?.value, '42 ms')
  assert.equal(rows.some(row => row.label.toLowerCase().includes('token')), false)
  const armedRows = playlistDebugRows({ ...runtime, phase: 'ARMED', activation_at: new Date(Date.now() + 1200).toISOString() })
  assert.equal(armedRows.find(row => row.label === 'Phase')?.value, 'ARMED')
  assert.match(armedRows.find(row => row.label === 'Starts in')?.value ?? '', /^00:0[01]\.[0-9]$/)
})
