import type { Device } from './types'
import { deviceRect } from './lib/wallGeometry'

export function ScreenLayoutControls({ device, onChange }: { device: Device; onChange: (change: Partial<Device>) => void }) {
  const measured = device.auto_size === false
  const box = deviceRect(device)
  return <>
    <small>Player viewport: {device.width && device.height ? `${device.width} × ${device.height} px` : 'waiting for player'}</small>
    <label><input type="checkbox" checked={!measured} onChange={event => onChange({ auto_size: event.target.checked,
      ...(event.target.checked && device.width && device.height ? { layout_width: device.width, layout_height: device.height } : {}) })} /> Use resolution for layout</label>
    <small>{measured ? 'Measure the lit image area, excluding the bezel. All measured screens use millimetres.' : 'For mixed physical sizes, turn this off on every screen and enter measured sizes.'}</small>
    <button className="secondary" onClick={() => onChange({ auto_size: false, layout_width: 150, layout_height: 85 })}>Use 150 × 85 mm Pi panel</button>
    <div className="screen-measurements">
      <label>Width {measured ? '(mm)' : '(px)'}<input aria-label={`${device.name} width`} type="number" min="1" step="0.1" disabled={!measured} value={box.width} onChange={e => onChange({ layout_width: Math.max(1, Number(e.target.value)) })} /></label>
      <label>Height {measured ? '(mm)' : '(px)'}<input aria-label={`${device.name} height`} type="number" min="1" step="0.1" disabled={!measured} value={box.height} onChange={e => onChange({ layout_height: Math.max(1, Number(e.target.value)) })} /></label>
      <label>Left {measured ? '(mm)' : '(px)'}<input aria-label={`${device.name} left`} type="number" step="0.1" value={box.x} onChange={e => onChange({ layout_x: Number(e.target.value) })} /></label>
      <label>Top {measured ? '(mm)' : '(px)'}<input aria-label={`${device.name} top`} type="number" step="0.1" value={box.y} onChange={e => onChange({ layout_y: Number(e.target.value) })} /></label>
    </div>
  </>
}
