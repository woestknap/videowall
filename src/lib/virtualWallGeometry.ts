import type { Scene } from '../types'

export type WallLayoutMode = 'resolution' | 'physical'

export type VirtualWallDeviceInput = {
  deviceId: string
  layoutMode: WallLayoutMode
  x: number
  y: number
  width: number
  height: number
  viewportWidthPx?: number | null
  viewportHeightPx?: number | null
}

export type VirtualWallDeviceRegion = {
  deviceId: string
  xPx: number
  yPx: number
  widthPx: number
  heightPx: number
  viewportWidthPx: number | null
  viewportHeightPx: number | null
}

export type VirtualWallGeometry = {
  status: 'valid'
  layoutMode: WallLayoutMode
  widthPx: number
  heightPx: number
  geometryRevision: string
  virtualPixelsPerMm: number | null
  devices: VirtualWallDeviceRegion[]
}

export type InvalidVirtualWallGeometry = {
  status: 'invalid'
  reason: 'no-devices' | 'mixed-layout-units' | 'invalid-calibration' | 'invalid-device-geometry' | 'layout-mode-required'
}

export type VirtualWallGeometryResult = VirtualWallGeometry | InvalidVirtualWallGeometry

export type VirtualViewport = { width: number; height: number }
export type VirtualRect = { x: number; y: number; width: number; height: number }

export type VirtualPlaneTransform = {
  scaleX: number
  scaleY: number
  translateX: number
  translateY: number
  cssTransform: string
}

export type V2SceneRenderContract =
  | { status: 'valid'; canvas: VirtualRect; region: VirtualRect | null }
  | { status: 'invalid'; reason: string }

const GEOMETRY_PRECISION = 6

function normalizedNumber(value: number) {
  const rounded = Number(value.toFixed(GEOMETRY_PRECISION))
  return Object.is(rounded, -0) ? 0 : rounded
}

function revisionNumber(value: number) {
  return String(normalizedNumber(value))
}

// FNV-1a over a canonical, device-id-sorted string. Inputs intentionally include
// only layout mode, the physical scale, and device layout rectangles. Runtime
// viewport size and unrelated device metadata do not change wall geometry.
export function wallGeometryRevision(mode: WallLayoutMode, devices: VirtualWallDeviceInput[], virtualPixelsPerMm?: number | null) {
  const calibration = mode === 'physical' && typeof virtualPixelsPerMm === 'number' ? revisionNumber(virtualPixelsPerMm) : '-'
  const canonicalDevices = [...devices]
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
    .map(device => `${device.deviceId}:${revisionNumber(device.x)},${revisionNumber(device.y)},${revisionNumber(device.width)},${revisionNumber(device.height)}`)
    .join('|')
  const canonical = `${mode}|${calibration}|${canonicalDevices}`
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function deriveVirtualWallGeometry({ mode, devices, virtualPixelsPerMm }: {
  mode: WallLayoutMode
  devices: VirtualWallDeviceInput[]
  virtualPixelsPerMm?: number | null
}): VirtualWallGeometryResult {
  if (!devices.length) return { status: 'invalid', reason: 'no-devices' }
  if (devices.some(device => device.layoutMode !== mode)) return { status: 'invalid', reason: 'mixed-layout-units' }
  if (devices.some(device => ![device.x, device.y, device.width, device.height].every(Number.isFinite) || device.width <= 0 || device.height <= 0)) {
    return { status: 'invalid', reason: 'invalid-device-geometry' }
  }
  const scale = mode === 'physical' ? virtualPixelsPerMm : 1
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return { status: 'invalid', reason: 'invalid-calibration' }

  const minX = Math.min(...devices.map(device => device.x))
  const minY = Math.min(...devices.map(device => device.y))
  const maxX = Math.max(...devices.map(device => device.x + device.width))
  const maxY = Math.max(...devices.map(device => device.y + device.height))
  const regions = [...devices]
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
    .map(device => ({
      deviceId: device.deviceId,
      xPx: normalizedNumber((device.x - minX) * scale),
      yPx: normalizedNumber((device.y - minY) * scale),
      widthPx: normalizedNumber(device.width * scale),
      heightPx: normalizedNumber(device.height * scale),
      viewportWidthPx: device.viewportWidthPx ?? null,
      viewportHeightPx: device.viewportHeightPx ?? null,
    }))

  return {
    status: 'valid',
    layoutMode: mode,
    widthPx: normalizedNumber((maxX - minX) * scale),
    heightPx: normalizedNumber((maxY - minY) * scale),
    geometryRevision: wallGeometryRevision(mode, devices, virtualPixelsPerMm),
    virtualPixelsPerMm: mode === 'physical' ? scale : null,
    devices: regions,
  }
}

export function sceneGeometryVersion(scene: Pick<Scene, 'geometry_version'>) {
  return scene.geometry_version ?? 1
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseVirtualWallGeometry(value: unknown): VirtualWallGeometryResult | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.status === 'invalid' && typeof candidate.reason === 'string') {
    const reasons: InvalidVirtualWallGeometry['reason'][] = ['no-devices', 'mixed-layout-units', 'invalid-calibration', 'invalid-device-geometry', 'layout-mode-required']
    return reasons.includes(candidate.reason as InvalidVirtualWallGeometry['reason'])
      ? { status: 'invalid', reason: candidate.reason as InvalidVirtualWallGeometry['reason'] }
      : null
  }
  if (candidate.status !== 'valid' || (candidate.layoutMode !== 'resolution' && candidate.layoutMode !== 'physical') ||
    !positiveFinite(candidate.widthPx) || !positiveFinite(candidate.heightPx) || typeof candidate.geometryRevision !== 'string' ||
    !Array.isArray(candidate.devices)) return null
  const devices: VirtualWallDeviceRegion[] = []
  for (const item of candidate.devices) {
    if (!item || typeof item !== 'object') return null
    const device = item as Record<string, unknown>
    if (typeof device.deviceId !== 'string' || !finite(device.xPx) || !finite(device.yPx) ||
      !positiveFinite(device.widthPx) || !positiveFinite(device.heightPx) ||
      !(device.viewportWidthPx === null || positiveFinite(device.viewportWidthPx)) ||
      !(device.viewportHeightPx === null || positiveFinite(device.viewportHeightPx))) return null
    devices.push({
      deviceId: device.deviceId,
      xPx: device.xPx,
      yPx: device.yPx,
      widthPx: device.widthPx,
      heightPx: device.heightPx,
      viewportWidthPx: device.viewportWidthPx,
      viewportHeightPx: device.viewportHeightPx,
    })
  }
  const virtualPixelsPerMm = candidate.virtualPixelsPerMm
  if (!(virtualPixelsPerMm === null || positiveFinite(virtualPixelsPerMm))) return null
  return {
    status: 'valid', layoutMode: candidate.layoutMode, widthPx: candidate.widthPx, heightPx: candidate.heightPx,
    geometryRevision: candidate.geometryRevision, virtualPixelsPerMm, devices,
  }
}

export function validateV2SceneRender(scene: Scene, geometry: VirtualWallGeometryResult | null | undefined, deviceId?: string): V2SceneRenderContract {
  if (sceneGeometryVersion(scene) !== 2) return { status: 'invalid', reason: 'scene-is-not-v2' }
  if (!positiveFinite(scene.canvas_width_px) || !positiveFinite(scene.canvas_height_px)) return { status: 'invalid', reason: 'missing-or-invalid-canvas' }
  if (!geometry) return { status: 'invalid', reason: 'missing-virtual-wall-geometry' }
  if (geometry.status === 'invalid') return { status: 'invalid', reason: `invalid-virtual-wall-geometry:${geometry.reason}` }
  if (!scene.wall_geometry_revision || scene.wall_geometry_revision !== geometry.geometryRevision) return { status: 'invalid', reason: 'wall-geometry-revision-mismatch' }
  if (scene.canvas_width_px !== geometry.widthPx || scene.canvas_height_px !== geometry.heightPx) return { status: 'invalid', reason: 'canvas-wall-size-mismatch' }
  const unsupported = scene.layers.find(layer => layer.space !== 'wall' || layer.coordinateSpace !== 'virtual-pixel' ||
    ![layer.x, layer.y, layer.width, layer.height].every(Number.isFinite) || layer.width <= 0 || layer.height <= 0)
  if (unsupported) return { status: 'invalid', reason: `unsupported-layer-geometry:${unsupported.id}` }
  const region = deviceId ? geometry.devices.find(device => device.deviceId === deviceId) : undefined
  if (deviceId && !region) return { status: 'invalid', reason: 'missing-current-device-region' }
  return {
    status: 'valid',
    canvas: { x: 0, y: 0, width: scene.canvas_width_px, height: scene.canvas_height_px },
    region: region ? { x: region.xPx, y: region.yPx, width: region.widthPx, height: region.heightPx } : null,
  }
}

export function virtualPlaneTransform(view: VirtualRect, viewport: VirtualViewport): VirtualPlaneTransform | null {
  if (![view.x, view.y].every(Number.isFinite) || !positiveFinite(view.width) || !positiveFinite(view.height) ||
    !positiveFinite(viewport.width) || !positiveFinite(viewport.height)) return null
  const scaleX = viewport.width / view.width
  const scaleY = viewport.height / view.height
  const translateX = -view.x * scaleX || 0
  const translateY = -view.y * scaleY || 0
  return { scaleX, scaleY, translateX, translateY, cssTransform: `matrix(${scaleX}, 0, 0, ${scaleY}, ${translateX}, ${translateY})` }
}

export function projectVirtualRect(rect: VirtualRect, view: VirtualRect, viewport: VirtualViewport): VirtualRect | null {
  const transform = virtualPlaneTransform(view, viewport)
  if (!transform || ![rect.x, rect.y].every(Number.isFinite) || !positiveFinite(rect.width) || !positiveFinite(rect.height)) return null
  return {
    x: rect.x * transform.scaleX + transform.translateX,
    y: rect.y * transform.scaleY + transform.translateY,
    width: rect.width * transform.scaleX,
    height: rect.height * transform.scaleY,
  }
}

export function clipVirtualProjection(rect: VirtualRect, viewport: VirtualViewport): VirtualRect | null {
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  const right = Math.min(viewport.width, rect.x + rect.width)
  const bottom = Math.min(viewport.height, rect.y + rect.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}
