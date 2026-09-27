import type { Device } from '../types'
import type { Rect } from './wallGeometry.ts'

export type PhysicalDeviceRect = Rect & { deviceId: string }

export function includedPhysicalDevices(devices: Device[]) {
  return devices.filter(device => device.included_in_wall !== false)
}

export function physicalDeviceRects(devices: Device[]): PhysicalDeviceRect[] | null {
  const rectangles = devices.map(device => ({
    deviceId: device.id,
    x: device.layout_x,
    y: device.layout_y,
    width: device.layout_width,
    height: device.layout_height,
  }))
  return rectangles.every(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && (rect.width ?? 0) > 0 && (rect.height ?? 0) > 0)
    ? rectangles as PhysicalDeviceRect[]
    : null
}

export function physicalWallBounds(rectangles: PhysicalDeviceRect[]): Rect | null {
  if (!rectangles.length) return null
  const x = Math.min(...rectangles.map(rect => rect.x))
  const y = Math.min(...rectangles.map(rect => rect.y))
  const right = Math.max(...rectangles.map(rect => rect.x + rect.width))
  const bottom = Math.max(...rectangles.map(rect => rect.y + rect.height))
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

export function resetPhysicalPositions(devices: Device[], gapMm = 20): Device[] {
  let x = 0
  return devices.map(device => {
    if (device.included_in_wall === false) return device
    const positioned = { ...device, auto_size: false, layout_x: x, layout_y: 0 }
    const width = typeof device.layout_width === 'number' && Number.isFinite(device.layout_width) && device.layout_width > 0 ? device.layout_width : 1
    x += width + gapMm
    return positioned
  })
}

export function physicalDragPosition(start: { x: number; y: number }, clientDelta: { x: number; y: number }, canvas: { width: number; height: number }, visibleBounds: Pick<Rect, 'width' | 'height'>) {
  if (![canvas.width, canvas.height, visibleBounds.width, visibleBounds.height].every(value => Number.isFinite(value) && value > 0)) return start
  return {
    x: start.x + clientDelta.x / canvas.width * visibleBounds.width,
    y: start.y + clientDelta.y / canvas.height * visibleBounds.height,
  }
}

export function physicalDeviceSaveValues(device: Device) {
  if (device.included_in_wall === false) {
    return { name: device.name, auto_size: false, included_in_wall: false }
  }
  const rects = physicalDeviceRects([device])
  if (!rects) return null
  return {
    name: device.name,
    auto_size: false,
    included_in_wall: true,
    layout_x: rects[0].x,
    layout_y: rects[0].y,
    layout_width: rects[0].width,
    layout_height: rects[0].height,
  }
}
