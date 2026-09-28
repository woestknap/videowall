import type { Device, SceneLayer } from '../types'

export type LiveSourceSummary = { id: string; name: string; layerIds: string[]; targetDeviceIds: string[] }

export function liveSourcesForLayers(layers: SceneLayer[], sceneDevices: Device[]) {
  const sources = new Map<string, LiveSourceSummary>()
  for (const layer of layers) {
    if (layer.type !== 'live' || !layer.content.liveSourceId) continue
    const id = layer.content.liveSourceId
    const current = sources.get(id) ?? { id, name: layer.content.liveSourceName?.trim() || `Live source ${sources.size + 1}`, layerIds: [], targetDeviceIds: [] }
    if (layer.content.liveSourceName?.trim()) current.name = layer.content.liveSourceName.trim()
    current.layerIds.push(layer.id)
    const targets = layer.target.length ? layer.target : sceneDevices.map(device => device.id)
    current.targetDeviceIds = [...new Set([...current.targetDeviceIds, ...targets])]
    sources.set(id, current)
  }
  return [...sources.values()]
}

export function sourceLayersRemain(layers: SceneLayer[], liveSourceId: string, removingLayerId: string) {
  return layers.some(layer => layer.id !== removingLayerId && layer.type === 'live' && layer.content.liveSourceId === liveSourceId)
}
