import { useRef, useState, type PointerEvent } from 'react'
import { ScreenLayoutControls } from '../ScreenLayoutControls'
import { includedPhysicalDevices, physicalDeviceRects, physicalDragPosition, physicalWallBounds } from '../lib/physicalWallLayout'
import type { VirtualWallGeometryResult } from '../lib/virtualWallGeometry'
import type { Device, Wall } from '../types'

type Drag = {
  deviceId: string
  pointerId: number
  startClient: { x: number; y: number }
  startPosition: { x: number; y: number }
  canvas: { width: number; height: number }
  bounds: { x: number; y: number; width: number; height: number }
}

function paddedBounds(bounds: { x: number; y: number; width: number; height: number }) {
  const paddingX = Math.max(10, bounds.width * .04)
  const paddingY = Math.max(10, bounds.height * .04)
  return { x: bounds.x - paddingX, y: bounds.y - paddingY, width: bounds.width + paddingX * 2, height: bounds.height + paddingY * 2 }
}

export function PhysicalWallEditor({ wall, devices, geometry, dirty, onChange, onReset, onSave }: {
  wall: Wall
  devices: Device[]
  geometry: VirtualWallGeometryResult | null
  dirty: boolean
  onChange: (deviceId: string, change: Partial<Device>) => void
  onReset: () => void
  onSave: () => void
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const includedDevices = includedPhysicalDevices(devices)
  const rectangles = physicalDeviceRects(includedDevices)
  const exactBounds = rectangles ? physicalWallBounds(rectangles) : null
  const visibleBounds = drag?.bounds ?? (exactBounds ? paddedBounds(exactBounds) : null)
  const displayDevices = rectangles ? includedDevices.map(device => ({ device, index: devices.findIndex(item => item.id === device.id), rect: rectangles.find(item => item.deviceId === device.id)! }))
    .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height) : []

  function startDrag(event: PointerEvent<HTMLDivElement>, device: Device) {
    if (event.button !== 0 || !visibleBounds) return
    const canvasRect = canvasRef.current?.getBoundingClientRect()
    if (!canvasRect?.width || !canvasRect.height) return
    setDrag({
      deviceId: device.id,
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startPosition: { x: device.layout_x ?? 0, y: device.layout_y ?? 0 },
      canvas: { width: canvasRect.width, height: canvasRect.height },
      bounds: visibleBounds,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const position = physicalDragPosition(drag.startPosition, { x: event.clientX - drag.startClient.x, y: event.clientY - drag.startClient.y }, drag.canvas, drag.bounds)
    onChange(drag.deviceId, { auto_size: false, layout_x: position.x, layout_y: position.y })
  }

  return <div className="physical-wall-editor">
    <div className="physical-wall-summary">
      <span>Physical wall: <strong>{exactBounds ? `${exactBounds.width} × ${exactBounds.height} mm` : 'invalid geometry'}</strong></span>
      <span>Virtual canvas: <strong>{geometry?.status === 'valid' ? `${geometry.widthPx} × ${geometry.heightPx} px` : geometry ? `invalid (${geometry.reason})` : 'unavailable'}</strong></span>
      <span>Scale: <strong>{wall.virtual_pixels_per_mm ?? 'not set'} virtual px/mm</strong></span>
    </div>
    <p className="physical-wall-caution">All four layout values below are millimetres. Existing legacy X/Y values are not converted automatically; verify them or deliberately reset the positions.</p>
    <div className="physical-wall-actions"><button className="sm-button sm-button-secondary" onClick={onReset}>Reset physical positions</button><button className="sm-button" disabled={!dirty || !rectangles} onClick={onSave}>Save physical layout</button></div>
    {visibleBounds && rectangles ? <div className="physical-wall-canvas screenmesh-workspace-grid" ref={canvasRef} style={{ aspectRatio: `${visibleBounds.width} / ${visibleBounds.height}`, width: `min(100%, calc(65vh * ${visibleBounds.width / visibleBounds.height}))` }} onPointerMove={moveDrag} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
      {displayDevices.map(({ device, index, rect }) => {
        return <div className={`physical-wall-screen ${drag?.deviceId === device.id ? 'is-dragging' : ''}`} key={device.id} style={{ left: `${(rect.x - visibleBounds.x) / visibleBounds.width * 100}%`, top: `${(rect.y - visibleBounds.y) / visibleBounds.height * 100}%`, width: `${rect.width / visibleBounds.width * 100}%`, height: `${rect.height / visibleBounds.height * 100}%` }} onPointerDown={event => startDrag(event, device)}>
          <span>{index + 1}</span><strong>{device.name}</strong><small>{rect.width} × {rect.height} mm</small>
        </div>
      })}
    </div> : <p className="physical-wall-invalid">{includedDevices.length ? 'Enter valid X, Y, Width and Height values for every included device to preview the wall.' : 'Include at least one screen to create physical wall geometry.'}</p>}
    <div className="physical-device-calibration-list">
      {devices.map(device => <details className={`screen-list-item ${device.included_in_wall === false ? 'is-wall-excluded' : ''}`} open key={device.id}><summary><strong>{device.name}</strong><small>{device.width && device.height ? `Viewport ${device.width} × ${device.height} px` : 'Player viewport unavailable'}</small></summary><div className="screen-details-body"><label className="physical-wall-inclusion"><input type="checkbox" checked={device.included_in_wall !== false} onChange={event => onChange(device.id, { included_in_wall: event.target.checked })} /> Include in wall</label><ScreenLayoutControls device={device} layoutMode="physical" onChange={change => onChange(device.id, { ...change, auto_size: false })} /></div></details>)}
    </div>
  </div>
}
