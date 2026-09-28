import type { Scene, SceneLayer } from '../types'
import type { V2SceneRenderContract, VirtualWallDeviceRegion, VirtualWallGeometryResult } from '../lib/virtualWallGeometry'

export type DebugRow = { label: string; value: string; detail?: string }
export type LiveDebugState = 'WAITING' | 'CONNECTING' | 'CONNECTED' | 'NEGOTIATING' | 'STREAMING' | 'RECONNECTING' | 'ENDED' | 'ERROR'

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

export function liveDebugRows(layers: SceneLayer[], leaseSourceIds: string[], states: Readonly<Record<string, LiveDebugState>>, streams: ReadonlyMap<string, MediaStream>): DebugRow[] {
  const names = new Map<string, string>()
  for (const layer of layers) if (layer.type === 'live' && layer.content.liveSourceId) names.set(layer.content.liveSourceId, layer.content.liveSourceName?.trim() || `Source ${shortDebugId(layer.content.liveSourceId)}`)
  const ids = [...new Set([...names.keys(), ...leaseSourceIds])]
  return ids.map(id => ({ label: names.get(id) ?? `Source ${shortDebugId(id)}`, value: states[id] ?? (leaseSourceIds.includes(id) ? 'WAITING' : 'NO LEASE'), detail: streams.has(id) ? 'video track present' : undefined }))
}

export function mediaDebugRows(layers: SceneLayer[], states: Readonly<Record<string, string>>): DebugRow[] {
  const images = layers.filter(layer => layer.type === 'image').length
  const videos = layers.filter(layer => layer.type === 'video')
  const rows: DebugRow[] = [{ label: 'Images', value: String(images) }, { label: 'Videos', value: String(videos.length) }]
  for (const layer of videos) rows.push({ label: `Video ${shortDebugId(layer.id)}`, value: states[layer.id] ?? 'LOADING' })
  return rows
}

export function playerHealthSummary({ scene, contract, status, signaling }: { scene: Scene | null; contract: V2SceneRenderContract | null; status: string; signaling: string }) {
  if (!scene) return status.startsWith('Connection issue') ? 'PLAYER OFFLINE' : 'NO SCENE'
  if (contract?.status === 'invalid') return 'GEOMETRY ERROR'
  if (signaling === 'error' || signaling === 'disconnected') return 'SIGNALING OFFLINE'
  return 'PLAYER OK'
}
