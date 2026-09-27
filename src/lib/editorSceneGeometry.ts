import type { Device, LayerType, Scene, SceneLayer, Wall } from '../types'
import { WALL_WORKSPACE_HEIGHT, WALL_WORKSPACE_WIDTH, type Rect } from './wallGeometry.ts'
import { deriveVirtualWallGeometry, sceneGeometryVersion, type VirtualWallGeometryResult } from './virtualWallGeometry.ts'

export type SceneCanvas = { width: number; height: number }

export function virtualGeometryForWall(wall: Wall | null | undefined, devices: Device[]): VirtualWallGeometryResult {
  if (!wall?.layout_mode) return { status: 'invalid', reason: 'layout-mode-required' }
  const geometryDevices = wall.layout_mode === 'physical'
    ? devices.filter(device => device.included_in_wall !== false)
    : devices
  return deriveVirtualWallGeometry({
    mode: wall.layout_mode,
    virtualPixelsPerMm: wall.virtual_pixels_per_mm,
    devices: geometryDevices.filter(device => device.wall_id === wall.id).map(device => ({
      deviceId: device.id,
      layoutMode: device.auto_size === false ? 'physical' : 'resolution',
      x: device.layout_x ?? Number.NaN,
      y: device.layout_y ?? Number.NaN,
      width: device.layout_width ?? Number.NaN,
      height: device.layout_height ?? Number.NaN,
      viewportWidthPx: device.width,
      viewportHeightPx: device.height,
    })),
  })
}

export function v2SceneCreateValues(name: string, wall: Wall | null | undefined, devices: Device[]) {
  if (!wall) return { status: 'invalid' as const, reason: 'Select a wall first.' }
  const geometry = virtualGeometryForWall(wall, devices)
  if (geometry.status === 'invalid') return { status: 'invalid' as const, reason: `Virtual wall geometry is invalid: ${geometry.reason}.` }
  return {
    status: 'valid' as const,
    values: {
      name,
      layers: [] as SceneLayer[],
      duration_seconds: 60,
      device_ids: [] as string[],
      wall_id: wall.id,
      geometry_version: 2 as const,
      canvas_width_px: geometry.widthPx,
      canvas_height_px: geometry.heightPx,
      wall_geometry_revision: geometry.geometryRevision,
    },
    geometry,
  }
}

export function editorSceneCanvas(scene: Pick<Scene, 'geometry_version' | 'canvas_width_px' | 'canvas_height_px'>): SceneCanvas | null {
  if (sceneGeometryVersion(scene) !== 2) return { width: WALL_WORKSPACE_WIDTH, height: WALL_WORKSPACE_HEIGHT }
  return typeof scene.canvas_width_px === 'number' && Number.isFinite(scene.canvas_width_px) && scene.canvas_width_px > 0 &&
    typeof scene.canvas_height_px === 'number' && Number.isFinite(scene.canvas_height_px) && scene.canvas_height_px > 0
    ? { width: scene.canvas_width_px, height: scene.canvas_height_px }
    : null
}

export function editorVirtualDeviceRects(scene: Scene, geometry: VirtualWallGeometryResult | null | undefined) {
  if (sceneGeometryVersion(scene) !== 2 || geometry?.status !== 'valid') return []
  return geometry.devices
    .map(region => ({ deviceId: region.deviceId, x: region.xPx, y: region.yPx, width: region.widthPx, height: region.heightPx }))
}

export function editorLayerRect(scene: Scene, layer: SceneLayer, reference?: Rect): Rect {
  if (sceneGeometryVersion(scene) === 2) return { x: layer.x, y: layer.y, width: layer.width, height: layer.height }
  const canvas = editorSceneCanvas(scene)!
  const area = reference ?? { x: 0, y: 0, ...canvas }
  return {
    x: area.x + layer.x / 100 * area.width,
    y: area.y + layer.y / 100 * area.height,
    width: layer.width / 100 * area.width,
    height: layer.height / 100 * area.height,
  }
}

export function moveEditorLayer(scene: Scene, layer: SceneLayer, delta: { x: number; y: number }, reference: Pick<Rect, 'width' | 'height'>) {
  return sceneGeometryVersion(scene) === 2
    ? { x: layer.x + delta.x, y: layer.y + delta.y }
    : { x: layer.x + delta.x / reference.width * 100, y: layer.y + delta.y / reference.height * 100 }
}

export function newEditorLayer(scene: Scene, type: Extract<LayerType, 'image' | 'video' | 'live'>, id: string, zIndex: number, liveSourceId?: string): SceneLayer {
  if (sceneGeometryVersion(scene) === 2) {
    const canvas = editorSceneCanvas(scene)
    if (!canvas) throw new Error('V2 scene canvas is invalid.')
    const width = Math.min(canvas.width * .25, canvas.height * (16 / 9) * .25)
    const height = width / (16 / 9)
    return { id, type, target: [], space: 'wall', coordinateSpace: 'virtual-pixel', x: canvas.width * .1, y: canvas.height * .1, width, height, zIndex, scale: 1, rotation: 0, lockedAspect: true, aspectRatio: 16 / 9, content: type === 'live' ? { liveSourceId: liveSourceId ?? id } : { url: '', fit: 'contain' } }
  }
  throw new Error('V1 layer defaults remain in the existing editor path.')
}

export function fitVirtualLayerToRegions(layer: SceneLayer, regions: Array<Rect & { deviceId: string }>): SceneLayer {
  const selected = regions.filter(region => !layer.target.length || layer.target.includes(region.deviceId))
  if (!selected.length) return layer
  const x = Math.min(...selected.map(region => region.x))
  const y = Math.min(...selected.map(region => region.y))
  const right = Math.max(...selected.map(region => region.x + region.width))
  const bottom = Math.max(...selected.map(region => region.y + region.height))
  return { ...layer, space: 'wall', coordinateSpace: 'virtual-pixel', x, y, width: right - x, height: bottom - y, rotation: 0, scale: 1 }
}

export function v2WallGeometryWarning(scene: Scene, geometry: VirtualWallGeometryResult | null | undefined) {
  if (sceneGeometryVersion(scene) !== 2) return null
  if (!geometry) return 'Current wall geometry is unavailable. Editing continues on the saved virtual canvas.'
  if (geometry.status === 'invalid') return `Current wall geometry is invalid (${geometry.reason}). Editing continues on the saved virtual canvas.`
  if (scene.wall_geometry_revision !== geometry.geometryRevision) return 'Wall geometry has changed. Editing continues on the saved virtual canvas; layers were not moved or resized.'
  return null
}

export function editorSceneSaveValues(scene: Scene) {
  const common = { name: scene.name, layers: scene.layers, duration_seconds: scene.duration_seconds, device_ids: scene.device_ids ?? [] }
  return sceneGeometryVersion(scene) === 2 ? {
    ...common,
    wall_id: scene.wall_id,
    geometry_version: 2 as const,
    canvas_width_px: scene.canvas_width_px,
    canvas_height_px: scene.canvas_height_px,
    wall_geometry_revision: scene.wall_geometry_revision,
  } : common
}
