import type { ManualSceneRuntime, PlaylistRuntime, Scene, SceneLayer } from '../types'
import { formatPlaylistActivationRemaining, formatPlaylistRemaining, playlistActivationRemainingMs, playlistLoadingOverlayState, playlistRemainingMs, type PlaylistTimingDiagnostics } from '../lib/playlistRuntime.ts'
import type { V2SceneRenderContract, VirtualWallDeviceRegion, VirtualWallGeometryResult } from '../lib/virtualWallGeometry'
import { compactMetric, type ReceiverPerformanceStats } from '../lib/livePerformanceStats.ts'
import type { VideoSyncDiagnostics } from '../lib/videoSync.ts'

export type DebugRow = { label: string; value: string; detail?: string }
export type LiveDebugState = 'WAITING' | 'CONNECTING' | 'CONNECTED' | 'NEGOTIATING' | 'STREAMING' | 'RECONNECTING' | 'ENDED' | 'ERROR'
export type LiveSourceDiagnostic = {
  socketState?: 'CONNECTING' | 'OPEN' | 'CLOSED'
  socketError?: boolean
  lastCloseCode?: number
  lastCloseReason?: string
  lastCloseWasClean?: boolean
  lastCloseAtMs?: number
  sessionId?: string
  generation?: number
  targetDeviceId?: string
  expiresAt?: string
  peerConnectionState?: RTCPeerConnectionState
  iceConnectionState?: RTCIceConnectionState
  receiverStats?: ReceiverPerformanceStats
}

export function mergeLiveSourceDiagnostic(previous: LiveSourceDiagnostic | undefined, update: LiveSourceDiagnostic): LiveSourceDiagnostic {
  return previous?.sessionId && update.sessionId && previous.sessionId !== update.sessionId ? update : { ...previous, ...update }
}

function lastCloseDetail(diagnostic: LiveSourceDiagnostic | undefined, now = Date.now()) {
  if (diagnostic?.lastCloseCode === undefined) return ''
  const cleanliness = diagnostic.lastCloseWasClean === undefined ? '' : diagnostic.lastCloseWasClean ? ' clean' : ' unclean'
  const reason = diagnostic.lastCloseReason ? ` (${diagnostic.lastCloseReason})` : ''
  const age = diagnostic.lastCloseAtMs === undefined ? '' : ` ${Math.max(0, Math.floor((now - diagnostic.lastCloseAtMs) / 1000))}s ago`
  return `last-close=${diagnostic.lastCloseCode}${cleanliness}${reason}${age}`
}

export function shortDebugId(value: string | null | undefined) {
  return value ? (value.length <= 10 ? value : `${value.slice(0, 8)}…`) : '—'
}

export function v2RevisionStatus(scene: Scene, geometry: VirtualWallGeometryResult | null, contract: V2SceneRenderContract | null) {
  if (scene.geometry_version !== 2) return null
  if (!scene.wall_geometry_revision || !geometry || geometry.status !== 'valid') return 'MISSING'
  return contract?.status === 'invalid' && contract.reason === 'wall-geometry-revision-mismatch' ? 'MISMATCH' : 'MATCHED'
}

export function geometryDebugRows(scene: Scene | null, geometry: VirtualWallGeometryResult | null, contract: V2SceneRenderContract | null, region: VirtualWallDeviceRegion | undefined, viewport: { width: number; height: number }): DebugRow[] {
  if (!scene) return [{ label: 'Geometry', value: 'No active scene' }]
  if ((scene.geometry_version ?? 1) !== 2) return [{ label: 'Geometry', value: 'V1' }, { label: 'Viewport', value: `${viewport.width} × ${viewport.height}` }]
  const rows: DebugRow[] = [
    { label: 'Geometry', value: contract?.status === 'valid' ? 'V2 OK' : 'V2 ERROR', detail: contract?.status === 'invalid' ? contract.reason : undefined },
    { label: 'Canvas', value: `${scene.canvas_width_px ?? '—'} × ${scene.canvas_height_px ?? '—'}` },
    { label: 'Viewport', value: `${viewport.width} × ${viewport.height}` },
    { label: 'Revision', value: v2RevisionStatus(scene, geometry, contract) ?? '—' },
  ]
  if (region) rows.splice(2, 0, { label: 'Region', value: `x=${region.xPx} y=${region.yPx} w=${region.widthPx} h=${region.heightPx}` })
  else rows.splice(2, 0, { label: 'Region', value: 'Missing' })
  if (geometry?.status === 'invalid') rows.push({ label: 'Wall geometry', value: 'INVALID', detail: geometry.reason })
  return rows
}

export function liveDebugRows(layers: SceneLayer[], leaseSourceIds: string[], states: Readonly<Record<string, LiveDebugState>>, streams: ReadonlyMap<string, MediaStream>, diagnostics: Readonly<Record<string, LiveSourceDiagnostic>> = {}): DebugRow[] {
  const names = new Map<string, string>()
  for (const layer of layers) if (layer.type === 'live' && layer.content.liveSourceId) names.set(layer.content.liveSourceId, layer.content.liveSourceName?.trim() || `Source ${shortDebugId(layer.content.liveSourceId)}`)
  const ids = [...new Set([...names.keys(), ...leaseSourceIds])]
  return ids.map(id => {
    const diagnostic = diagnostics[id]
    const detail = [
      streams.has(id) ? 'video track present' : '',
      diagnostic?.socketState ? `ws=${diagnostic.socketState}` : '',
      lastCloseDetail(diagnostic),
      diagnostic?.socketError ? 'ws-error' : '',
      diagnostic?.sessionId ? `session=${shortDebugId(diagnostic.sessionId)}` : '',
      diagnostic?.generation === undefined ? '' : `generation=${diagnostic.generation}`,
      `source=${shortDebugId(id)}`,
      diagnostic?.targetDeviceId ? `target=${shortDebugId(diagnostic.targetDeviceId)}` : '',
      diagnostic?.expiresAt ? `expires=${diagnostic.expiresAt}` : '',
      diagnostic?.peerConnectionState ? `peer=${diagnostic.peerConnectionState}` : '',
      diagnostic?.iceConnectionState ? `ice=${diagnostic.iceConnectionState}` : '',
      diagnostic?.receiverStats?.inboundMbps === undefined ? '' : `in=${compactMetric(diagnostic.receiverStats.inboundMbps)}Mbps`,
      diagnostic?.receiverStats?.receiveFps === undefined ? '' : `recv=${compactMetric(diagnostic.receiverStats.receiveFps)}fps`,
      diagnostic?.receiverStats?.packetsReceived === undefined ? '' : `packets=${diagnostic.receiverStats.packetsReceived}`,
      diagnostic?.receiverStats?.packetsLost === undefined ? '' : `lost=${diagnostic.receiverStats.packetsLost}`,
      diagnostic?.receiverStats?.framesReceived === undefined ? '' : `frames=${diagnostic.receiverStats.framesReceived}`,
      diagnostic?.receiverStats?.framesDecoded === undefined ? '' : `decoded=${diagnostic.receiverStats.framesDecoded}`,
      diagnostic?.receiverStats?.framesDropped === undefined ? '' : `dropped=${diagnostic.receiverStats.framesDropped}`,
      diagnostic?.receiverStats?.totalDecodeTime === undefined ? '' : `decode=${compactMetric(diagnostic.receiverStats.totalDecodeTime, 2)}s`,
      diagnostic?.receiverStats?.keyFramesDecoded === undefined ? '' : `keyframes=${diagnostic.receiverStats.keyFramesDecoded}`,
      diagnostic?.receiverStats?.packetLossPercent === undefined ? '' : `loss=${compactMetric(diagnostic.receiverStats.packetLossPercent)}%`,
      diagnostic?.receiverStats?.jitterMs === undefined ? '' : `jitter=${compactMetric(diagnostic.receiverStats.jitterMs)}ms`,
      diagnostic?.receiverStats?.roundTripTimeMs === undefined ? '' : `rtt=${compactMetric(diagnostic.receiverStats.roundTripTimeMs)}ms`,
      diagnostic?.receiverStats?.candidateType ? `ice=${diagnostic.receiverStats.candidateType}` : '',
      diagnostic?.receiverStats?.presentationFps === undefined ? '' : `presented=${compactMetric(diagnostic.receiverStats.presentationFps)}fps`,
      diagnostic?.receiverStats?.inboundVideoStatsAvailable === false ? 'receiver-stats=unavailable' : '',
      diagnostic?.receiverStats?.statsEntries === undefined ? '' : `stats-entries=${diagnostic.receiverStats.statsEntries}`,
      diagnostic?.receiverStats?.videoReceivers === undefined ? '' : `video-receivers=${diagnostic.receiverStats.videoReceivers}`,
    ].filter(Boolean).join(' · ')
    return { label: names.get(id) ?? `Source ${shortDebugId(id)}`, value: states[id] ?? (leaseSourceIds.includes(id) ? 'WAITING' : 'NO LEASE'), detail: detail || undefined }
  })
}

export function mediaDebugRows(layers: SceneLayer[], states: Readonly<Record<string, string>>, syncDiagnostics: Readonly<Record<string, VideoSyncDiagnostics>> = {}): DebugRow[] {
  const images = layers.filter(layer => layer.type === 'image').length
  const videos = layers.filter(layer => layer.type === 'video')
  const rows: DebugRow[] = [{ label: 'Images', value: String(images) }, { label: 'Videos', value: String(videos.length) }]
  for (const layer of videos) {
    const diagnostic = syncDiagnostics[layer.id]
    const detail = diagnostic ? `drift=${Math.round(diagnostic.driftMs)}ms · rate=${diagnostic.playbackRate.toFixed(3)} · ${diagnostic.band} · seeks=${diagnostic.hardSeekCount}${diagnostic.lastHardSeekAtMs === undefined ? '' : ` · last-seek=${Math.max(0, Math.floor((performance.now() - diagnostic.lastHardSeekAtMs) / 1000))}s ago`}` : undefined
    rows.push({ label: `Video ${shortDebugId(layer.id)}`, value: states[layer.id] ?? 'LOADING', detail })
  }
  return rows
}

function formatSignedMilliseconds(value: number) { return `${value >= 0 ? '+' : ''}${Math.round(value)} ms` }

export function playlistDebugRows(runtime: PlaylistRuntime | null, nowMs = Date.now(), timing: PlaylistTimingDiagnostics = {}): DebugRow[] {
  if (!runtime || runtime.status === 'STOPPED') return [{ label: 'Playlist', value: 'STOPPED' }]
  const rows: DebugRow[] = [
    { label: 'Playlist', value: runtime.playlist_name },
    { label: 'Status', value: runtime.status },
    { label: 'Item', value: `${Math.max(0, runtime.current_index) + 1} / ${runtime.item_count}` },
    { label: 'Generation', value: shortDebugId(runtime.generation) },
    { label: 'Sequence', value: String(runtime.sequence) },
    { label: 'Phase', value: runtime.phase },
  ]
  if (runtime.phase === 'PREPARING') {
    rows.push({ label: 'Target', value: runtime.target_scene_name ?? shortDebugId(runtime.target_scene_id) })
    const loader = playlistLoadingOverlayState(runtime, nowMs)
    rows.push({ label: 'Loader', value: loader.phase === 'WAITING' && loader.nextAtMs !== null ? `IN ${formatPlaylistActivationRemaining(Math.max(0, loader.nextAtMs - nowMs))}` : loader.phase === 'FADING_IN' ? 'FADING IN' : loader.mounted ? 'VISIBLE' : 'NONE' })
    rows.push({ label: 'Ready', value: `${runtime.ready_count} / ${runtime.expected_count}` })
    rows.push({ label: 'Timeout', value: runtime.transition_deadline_at ? formatPlaylistRemaining(Math.max(0, Date.parse(runtime.transition_deadline_at) - nowMs)) : '—' })
  } else if (runtime.phase === 'ARMED') {
    rows.push({ label: 'Target', value: runtime.target_scene_name ?? shortDebugId(runtime.target_scene_id) })
    rows.push({ label: 'Starts in', value: formatPlaylistActivationRemaining(playlistActivationRemainingMs(runtime, nowMs)) })
  } else rows.push({ label: 'Next', value: formatPlaylistRemaining(playlistRemainingMs(runtime, nowMs)) })
  if (timing.loaderSkewMs !== undefined) rows.push({ label: 'Loader skew', value: formatSignedMilliseconds(timing.loaderSkewMs) })
  if (timing.activationSkewMs !== undefined) rows.push({ label: 'Activation skew', value: formatSignedMilliseconds(timing.activationSkewMs) })
  if (timing.clockRoundTripMs !== undefined) rows.push({ label: 'Clock RTT', value: `${Math.round(timing.clockRoundTripMs)} ms` })
  if (timing.pollRoundTripMs !== undefined) rows.push({ label: 'Poll RTT', value: `${Math.round(timing.pollRoundTripMs)} ms` })
  if (runtime.degraded) rows.push({ label: 'Transition', value: 'DEGRADED', detail: `${runtime.failed_device_ids.length} player(s) missed readiness` })
  return rows
}

export function manualSceneDebugRows(runtime: ManualSceneRuntime | null, targetName?: string, nowMs = Date.now(), timing: PlaylistTimingDiagnostics = {}): DebugRow[] {
  if (!runtime) return [{ label: 'Manual stage', value: 'IDLE' }]
  const rows: DebugRow[] = [
    { label: 'Manual stage', value: runtime.status },
    { label: 'Target', value: targetName ?? shortDebugId(runtime.target_scene_id) },
    { label: 'Ready', value: `${runtime.ready_device_ids.length} / ${runtime.expected_device_ids.length}` },
  ]
  if (runtime.status === 'ARMED') rows.push({ label: 'Activation in', value: formatPlaylistActivationRemaining(runtime.activation_at ? Math.max(0, Date.parse(runtime.activation_at) - nowMs) : null) })
  if (timing.activationSkewMs !== undefined) rows.push({ label: 'Activation skew', value: formatSignedMilliseconds(timing.activationSkewMs) })
  if (runtime.failed_device_ids.length) rows.push({ label: 'Unavailable', value: String(runtime.failed_device_ids.length) })
  return rows
}

export function playerHealthSummary({ scene, contract, status, signaling }: { scene: Scene | null; contract: V2SceneRenderContract | null; status: string; signaling: string }) {
  if (!scene) return status.startsWith('Connection issue') ? 'PLAYER OFFLINE' : 'NO SCENE'
  if (contract?.status === 'invalid') return 'GEOMETRY ERROR'
  if (signaling === 'error' || signaling === 'disconnected') return 'SIGNALING OFFLINE'
  return 'PLAYER OK'
}
