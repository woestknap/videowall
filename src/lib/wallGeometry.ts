import type { Device, Scene, SceneLayer } from '../types'

// Existing scenes keep the same fixed workspace. In measured layouts one unit
// represents one millimetre; browser resolution only affects the final transform.
export const WALL_WORKSPACE_WIDTH = 7680
export const WALL_WORKSPACE_HEIGHT = 4320
export type Rect = { x: number; y: number; width: number; height: number }
export const WORKSPACE: Rect = { x: 0, y: 0, width: WALL_WORKSPACE_WIDTH, height: WALL_WORKSPACE_HEIGHT }

export function deviceRect(device: Device): Rect {
  return { x: device.layout_x ?? 0, y: device.layout_y ?? 0,
    width: Math.max(1, device.layout_width ?? device.width ?? 1920),
    height: Math.max(1, device.layout_height ?? device.height ?? 1080) }
}

export function bounds(rects: Rect[], includeOrigin = false): Rect {
  if (!rects.length) return WORKSPACE
  const x = Math.min(...rects.map(r => r.x), ...(includeOrigin ? [0] : []))
  const y = Math.min(...rects.map(r => r.y), ...(includeOrigin ? [0] : []))
  return { x, y, width: Math.max(1, Math.max(...rects.map(r => r.x + r.width)) - x),
    height: Math.max(1, Math.max(...rects.map(r => r.y + r.height)) - y) }
}

export function sceneDevices(scene: Scene, devices: Device[]) {
  return devices.filter(d => !scene.device_ids?.length || scene.device_ids.includes(d.id))
}

export function layerReference(layer: SceneLayer, scene: Scene, devices: Device[], current?: Device): Rect {
  if ((layer.space ?? 'screen') === 'screen') return current ? deviceRect(current) : WORKSPACE
  // Preserve the pre-freeform coordinate convention, including its origin.
  return layer.coordinateSpace === 'freeform' || layer.aspectRatio !== undefined
    ? WORKSPACE : bounds(sceneDevices(scene, devices).map(deviceRect), true)
}

export function toWorkspaceLayer(layer: SceneLayer, scene: Scene, devices: Device[]): SceneLayer {
  if (layer.space !== 'wall') return layer
  const reference = layerReference(layer, scene, devices)
  return { ...layer, coordinateSpace: 'freeform',
    x: (reference.x + layer.x / 100 * reference.width) / WORKSPACE.width * 100,
    y: (reference.y + layer.y / 100 * reference.height) / WORKSPACE.height * 100,
    width: layer.width / 100 * reference.width / WORKSPACE.width * 100,
    height: layer.height / 100 * reference.height / WORKSPACE.height * 100 }
}

// Rotate and fit media in the shared wall plane FIRST, then map to the screen's
// pixels. Applying rotation/object-fit after scaling to different pixel densities
// would create a different crop on each display (especially non-square pixels).
export function planeTransform(reference: Rect, view: Rect, width: number, height: number) {
  const sx = width / view.width, sy = height / view.height
  return `matrix(${sx}, 0, 0, ${sy}, ${(reference.x - view.x) * sx}, ${(reference.y - view.y) * sy})`
}

export function fitLayerToDevices(layer: SceneLayer, devices: Device[]): SceneLayer {
  const box = bounds(devices.filter(d => !layer.target.length || layer.target.includes(d.id)).map(deviceRect))
  return { ...layer, space: 'wall', coordinateSpace: 'freeform',
    x: box.x / WORKSPACE.width * 100, y: box.y / WORKSPACE.height * 100,
    width: box.width / WORKSPACE.width * 100, height: box.height / WORKSPACE.height * 100,
    rotation: 0, scale: 1 }
}
