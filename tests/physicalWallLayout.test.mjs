import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { includedPhysicalDevices, physicalDeviceRects, physicalDeviceSaveValues, physicalDragPosition, physicalWallBounds, resetPhysicalPositions } from '../src/lib/physicalWallLayout.ts'
import { deriveVirtualWallGeometry } from '../src/lib/virtualWallGeometry.ts'
import { editorVirtualDeviceRects, v2SceneCreateValues, virtualGeometryForWall } from '../src/lib/editorSceneGeometry.ts'

const device = (id, name, x, y, widthMm, heightMm, viewportWidth = 1920, viewportHeight = 1080) => ({
  id, name, wall_id: 'wall', last_seen_at: null, width: viewportWidth, height: viewportHeight,
  layout_x: x, layout_y: y, layout_width: widthMm, layout_height: heightMm, auto_size: false,
})

const physicalWall = [
  device('tv', 'Main TV', 0, 0, 1100, 620, 3840, 2160),
  device('pi-1', 'Pi panel 1', 1120, 0, 150, 85, 800, 480),
  device('pi-2', 'Pi panel 2', 1290, 0, 150, 85, 1024, 600),
  device('pi-3', 'Pi panel 3', 1460, 0, 150, 85, 1280, 720),
  device('pi-4', 'Pi panel 4', 1630, 0, 150, 85, 1920, 1080),
]

function geometryInputs(devices, layoutMode = 'physical') {
  return devices.map(item => ({
    deviceId: item.id, layoutMode, x: item.layout_x, y: item.layout_y,
    width: item.layout_width, height: item.layout_height,
    viewportWidthPx: item.width, viewportHeightPx: item.height,
  }))
}

test('physical rectangles use stored millimetres and never viewport dimensions', () => {
  const rectangles = physicalDeviceRects(physicalWall)
  assert.ok(rectangles)
  assert.deepEqual(rectangles[0], { deviceId: 'tv', x: 0, y: 0, width: 1100, height: 620 })
  assert.deepEqual(rectangles[1], { deviceId: 'pi-1', x: 1120, y: 0, width: 150, height: 85 })
  assert.equal(rectangles[0].width / rectangles[1].width, 1100 / 150)
  assert.deepEqual(physicalWallBounds(rectangles), { x: 0, y: 0, width: 1780, height: 620 })
})

test('drag motion converts fitted canvas pixels back to millimetres', () => {
  assert.deepEqual(
    physicalDragPosition({ x: 1120, y: 20 }, { x: 89, y: 31 }, { width: 890, height: 310 }, { width: 1780, height: 620 }),
    { x: 1298, y: 82 },
  )
  assert.deepEqual(physicalDragPosition({ x: 5, y: 6 }, { x: 20, y: 20 }, { width: 0, height: 100 }, { width: 500, height: 300 }), { x: 5, y: 6 })
})

test('visual bounds calculation is read-only and cannot change physical measurements', () => {
  const before = structuredClone(physicalWall)
  const rectangles = physicalDeviceRects(physicalWall)
  physicalWallBounds(rectangles)
  assert.deepEqual(physicalWall, before)
})

test('viewport changes do not alter saved physical calibration or geometry revision', () => {
  const changedViewport = physicalWall.map(item => ({ ...item, width: item.width * 2, height: item.height * 2 }))
  assert.deepEqual(physicalDeviceSaveValues(changedViewport[0]), physicalDeviceSaveValues(physicalWall[0]))
  const before = deriveVirtualWallGeometry({ mode: 'physical', devices: geometryInputs(physicalWall), virtualPixelsPerMm: 2 })
  const after = deriveVirtualWallGeometry({ mode: 'physical', devices: geometryInputs(changedViewport), virtualPixelsPerMm: 2 })
  assert.equal(before.status, 'valid')
  assert.equal(after.status, 'valid')
  assert.equal(after.geometryRevision, before.geometryRevision)
  assert.deepEqual(after.devices.map(({ xPx, yPx, widthPx, heightPx }) => ({ xPx, yPx, widthPx, heightPx })), before.devices.map(({ xPx, yPx, widthPx, heightPx }) => ({ xPx, yPx, widthPx, heightPx })))
})

test('explicit reset creates deterministic non-overlapping positions and preserves size and viewport', () => {
  const reset = resetPhysicalPositions(physicalWall, 20)
  assert.deepEqual(reset.map(item => [item.layout_x, item.layout_y]), [[0, 0], [1120, 0], [1290, 0], [1460, 0], [1630, 0]])
  for (let index = 0; index < reset.length; index += 1) {
    assert.equal(reset[index].layout_width, physicalWall[index].layout_width)
    assert.equal(reset[index].layout_height, physicalWall[index].layout_height)
    assert.equal(reset[index].width, physicalWall[index].width)
    assert.equal(reset[index].height, physicalWall[index].height)
    assert.equal(reset[index].auto_size, false)
    if (index) assert.ok(reset[index].layout_x >= reset[index - 1].layout_x + reset[index - 1].layout_width)
  }
})

test('1100 x 620 TV and four 150 x 85 panels derive proportional virtual regions', () => {
  const geometry = deriveVirtualWallGeometry({ mode: 'physical', devices: geometryInputs(physicalWall), virtualPixelsPerMm: 2 })
  assert.equal(geometry.status, 'valid')
  assert.equal(geometry.widthPx, 3560)
  assert.equal(geometry.heightPx, 1240)
  const tv = geometry.devices.find(item => item.deviceId === 'tv')
  const panel = geometry.devices.find(item => item.deviceId === 'pi-1')
  assert.deepEqual({ x: tv.xPx, y: tv.yPx, width: tv.widthPx, height: tv.heightPx }, { x: 0, y: 0, width: 2200, height: 1240 })
  assert.deepEqual({ x: panel.xPx, y: panel.yPx, width: panel.widthPx, height: panel.heightPx }, { x: 2240, y: 0, width: 300, height: 170 })
  assert.equal(tv.widthPx / panel.widthPx, 1100 / 150)
  const scene = { id: 'scene', name: 'V2', duration_seconds: 60, device_ids: [], geometry_version: 2, canvas_width_px: geometry.widthPx, canvas_height_px: geometry.heightPx, wall_geometry_revision: geometry.geometryRevision, layers: [] }
  assert.deepEqual(editorVirtualDeviceRects(scene, geometry), geometry.devices.map(item => ({ deviceId: item.deviceId, x: item.xPx, y: item.yPx, width: item.widthPx, height: item.heightPx })))
})

test('resolution geometry contract remains unchanged', () => {
  const resolutionDevices = [device('a', 'A', 0, 0, 1920, 1080), { ...device('b', 'B', 1920, 0, 1280, 720), included_in_wall: false }]
  const geometry = deriveVirtualWallGeometry({ mode: 'resolution', devices: geometryInputs(resolutionDevices, 'resolution') })
  assert.equal(geometry.status, 'valid')
  assert.equal(geometry.widthPx, 3200)
  assert.equal(geometry.heightPx, 1080)
  assert.deepEqual(geometry.devices.map(item => [item.xPx, item.yPx, item.widthPx, item.heightPx]), [[0, 0, 1920, 1080], [1920, 0, 1280, 720]])
  const clientGeometry = virtualGeometryForWall({ id: 'wall', name: 'Resolution', layout_mode: 'resolution' }, resolutionDevices.map(item => ({ ...item, auto_size: true })))
  assert.equal(clientGeometry.status, 'valid')
  assert.equal(clientGeometry.devices.length, 2)
})

test('physical inclusion removes a device from bounds, outlines, and revision without losing calibration', () => {
  const wall = { id: 'wall', name: 'Physical', layout_mode: 'physical', virtual_pixels_per_mm: 2 }
  const original = virtualGeometryForWall(wall, physicalWall)
  const excludedDevices = physicalWall.map(item => item.id === 'tv' ? { ...item, included_in_wall: false } : item)
  const excluded = virtualGeometryForWall(wall, excludedDevices)
  assert.equal(original.status, 'valid')
  assert.equal(excluded.status, 'valid')
  assert.equal(excluded.devices.some(item => item.deviceId === 'tv'), false)
  assert.equal(excluded.widthPx, 1320)
  assert.equal(excluded.heightPx, 170)
  assert.notEqual(excluded.geometryRevision, original.geometryRevision)
  const scene = { id: 'scene', name: 'V2', duration_seconds: 60, device_ids: [], geometry_version: 2, canvas_width_px: excluded.widthPx, canvas_height_px: excluded.heightPx, wall_geometry_revision: excluded.geometryRevision, layers: [] }
  assert.equal(editorVirtualDeviceRects(scene, excluded).some(item => item.deviceId === 'tv'), false)
  const created = v2SceneCreateValues('New V2', wall, excludedDevices)
  assert.equal(created.status, 'valid')
  assert.equal(created.geometry.devices.some(item => item.deviceId === 'tv'), false)
  assert.deepEqual(
    excludedDevices.find(item => item.id === 'tv'),
    { ...physicalWall[0], included_in_wall: false },
  )
  const reenabled = virtualGeometryForWall(wall, excludedDevices.map(item => item.id === 'tv' ? { ...item, included_in_wall: true } : item))
  assert.equal(reenabled.status, 'valid')
  assert.equal(reenabled.geometryRevision, original.geometryRevision)
})

test('reset and save preserve excluded device calibration and persist its inclusion flag', () => {
  const devices = physicalWall.map(item => item.id === 'pi-2' ? { ...item, included_in_wall: false } : item)
  const excludedBefore = structuredClone(devices.find(item => item.id === 'pi-2'))
  const reset = resetPhysicalPositions(devices)
  assert.deepEqual(reset.find(item => item.id === 'pi-2'), excludedBefore)
  assert.equal(includedPhysicalDevices(reset).some(item => item.id === 'pi-2'), false)
  assert.deepEqual(physicalDeviceSaveValues({ ...excludedBefore, layout_width: Number.NaN }), { name: excludedBefore.name, auto_size: false, included_in_wall: false })
})

test('device inclusion migration defaults existing devices on and filters physical geometry only', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260927210000_physical_wall_device_inclusion.sql', import.meta.url), 'utf8')
  assert.match(sql, /included_in_wall boolean not null default true/)
  assert.equal(sql.match(/wall_mode <> 'physical' or included_in_wall/g)?.length, 3)
  assert.doesNotMatch(sql, /create or replace function public\.get_player_state/)
})

test('physical calibration is explicit, reset-only, and V2 scene guides are high contrast', () => {
  const admin = readFileSync(new URL('../src/admin/Admin.tsx', import.meta.url), 'utf8')
  const controls = readFileSync(new URL('../src/ScreenLayoutControls.tsx', import.meta.url), 'utf8')
  const editor = readFileSync(new URL('../src/editor/SceneEditorPage.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.match(admin, /Reset physical screen positions/)
  assert.match(admin, /resetPhysicalPositions\(current\)/)
  assert.match(controls, /viewport changes cannot overwrite these millimetre measurements/)
  assert.match(editor, /virtual-pixel-stage/)
  assert.match(css, /\.virtual-pixel-stage \.device-mask \{ border: 2px solid/)
  assert.doesNotMatch(admin, /resetPhysicalPositions\(devices\)/)
})
