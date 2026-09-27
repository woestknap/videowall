import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { clientPointToWorkspace, deltaClientToWorkspace, workspacePointToClient, zoomAroundCursor } from '../src/lib/editorZoom.ts'
import { editorLayerRect, editorSceneCanvas, editorSceneSaveValues, editorVirtualDeviceRects, fitVirtualLayerToRegions, moveEditorLayer, newEditorLayer, v2SceneCreateValues, v2WallGeometryWarning, virtualGeometryForWall } from '../src/lib/editorSceneGeometry.ts'
import { layerWithMediaAsset, mediaDimensionChange } from '../src/media/mediaLibraryUtils.ts'

const wall = { id: 'wall', name: 'Wall', layout_mode: 'resolution', virtual_pixels_per_mm: null }
const device = (id, x, width, viewportWidth = width, overrides = {}) => ({ id, name: id, wall_id: 'wall', last_seen_at: null, width: viewportWidth, height: 1080, layout_x: x, layout_y: 0, layout_width: width, layout_height: 1080, auto_size: true, ...overrides })
const devices = [device('a', 0, 2400, 1920), device('b', 2500, 1200, 3840)]
const layer = { id: 'layer', type: 'image', target: [], space: 'wall', coordinateSpace: 'virtual-pixel', x: 120.5, y: 80.25, width: 640, height: 360, zIndex: 1, lockedAspect: false, content: { url: '' } }
const scene = { id: 'scene', name: 'Pixels', duration_seconds: 60, wall_id: 'wall', geometry_version: 2, canvas_width_px: 3700, canvas_height_px: 1080, wall_geometry_revision: 'revision', device_ids: [], layers: [layer] }

test('valid wall creates an empty V2 scene with persisted canvas and revision', () => {
  const result = v2SceneCreateValues('New pixels', wall, devices)
  assert.equal(result.status, 'valid')
  assert.deepEqual(result.values, {
    name: 'New pixels', layers: [], duration_seconds: 60, device_ids: [], wall_id: 'wall', geometry_version: 2,
    canvas_width_px: 3700, canvas_height_px: 1080, wall_geometry_revision: result.geometry.geometryRevision,
  })
})

test('invalid or unselected wall refuses V2 creation', () => {
  assert.equal(v2SceneCreateValues('No wall', null, devices).status, 'invalid')
  const mixed = [devices[0], { ...devices[1], auto_size: false }]
  const result = v2SceneCreateValues('Mixed', wall, mixed)
  assert.equal(result.status, 'invalid')
  assert.match(result.reason, /mixed-layout-units/)
})

test('client and virtual-pixel positions round trip with zoom and pan', () => {
  const canvas = editorSceneCanvas(scene)
  const stage = { center: { x: 600, y: 400 }, width: 1000, height: 500 }
  const view = { zoom: 2.75, pan: { x: 83.5, y: -42.25 } }
  const point = { x: 1733.25, y: 412.75 }
  const client = workspacePointToClient(point, view, stage, canvas)
  assert.deepEqual(clientPointToWorkspace(client, view, stage, canvas), point)
})

test('V2 drag deltas remain direct virtual pixels at 50%, 100%, 200%, and 400% zoom', () => {
  const canvas = editorSceneCanvas(scene)
  const stage = { width: 925, height: 540 }
  for (const zoom of [.5, 1, 2, 4]) {
    const delta = deltaClientToWorkspace({ x: 25 * zoom, y: -10 * zoom }, zoom, stage, canvas)
    const moved = moveEditorLayer(scene, layer, delta, canvas)
    assert.equal(moved.x, layer.x + 100)
    assert.equal(moved.y, layer.y - 20)
  }
})

test('zoom and pan are view-only and do not alter stored V2 geometry', () => {
  const original = structuredClone(layer)
  const canvas = editorSceneCanvas(scene)
  zoomAroundCursor({ zoom: 1, pan: { x: 0, y: 0 } }, 4, { center: { x: 500, y: 300 }, width: 900, height: 500 }, { x: 300, y: 250 }, canvas)
  assert.deepEqual(layer, original)
})

test('inspector geometry and resizing operate on actual virtual pixels', () => {
  assert.deepEqual(editorLayerRect(scene, layer), { x: 120.5, y: 80.25, width: 640, height: 360 })
  const resized = { ...layer, ...mediaDimensionChange(layer, 'width', 800) }
  assert.equal(resized.width, 800)
  assert.equal(resized.height, 360)
  const source = readFileSync(new URL('../src/editor/SceneEditorPage.tsx', import.meta.url), 'utf8')
  for (const label of ['X (px)', 'Y (px)', 'Width (px)', 'Height (px)']) assert.match(source, new RegExp(label.replace(/[()]/g, '\\$&')))
})

test('V2 device outlines preserve unequal physical footprints, viewport independence, and gaps', () => {
  const physicalWall = { ...wall, layout_mode: 'physical', virtual_pixels_per_mm: 4 }
  const physicalDevices = [
    device('wide', -600, 600, 1920, { auto_size: false, layout_y: -10, layout_height: 300 }),
    device('narrow', 20, 300, 3840, { auto_size: false, layout_y: -10, layout_height: 300 }),
  ]
  const geometry = virtualGeometryForWall(physicalWall, physicalDevices)
  assert.equal(geometry.status, 'valid')
  const pixelScene = { ...scene, canvas_width_px: geometry.widthPx, canvas_height_px: geometry.heightPx, wall_geometry_revision: geometry.geometryRevision }
  const rects = editorVirtualDeviceRects(pixelScene, geometry)
  const wide = rects.find(rect => rect.deviceId === 'wide')
  const narrow = rects.find(rect => rect.deviceId === 'narrow')
  assert.equal(wide.width / narrow.width, 2)
  assert.equal(narrow.x - (wide.x + wide.width), 80)
  assert.equal(geometry.devices.find(region => region.deviceId === 'narrow').viewportWidthPx, 3840)
})

test('new V2 media/live layers use deterministic virtual-pixel placeholders', () => {
  for (const type of ['image', 'video', 'live']) {
    const created = newEditorLayer(scene, type, `new-${type}`, 2, 'live-source')
    assert.equal(created.coordinateSpace, 'virtual-pixel')
    assert.equal(created.space, 'wall')
    assert.equal(created.x, 370)
    assert.equal(created.y, 108)
    assert.ok(created.width > 0 && created.width < scene.canvas_width_px)
    assert.ok(created.height > 0 && created.height < scene.canvas_height_px)
    assert.equal(created.content.fit, type === 'live' ? undefined : 'contain')
  }
})

test('V2 first media assignment replaces placeholders, while later replacement preserves geometry', () => {
  const imageAsset = { id: 'image', name: 'Image', original_filename: 'image.png', object_key: 'image', public_url: 'https://media.example/image.png', mime_type: 'image/png', media_type: 'image', size_bytes: 1, width: 413, height: 325, duration_seconds: null, thumbnail_object_key: null, thumbnail_url: null, created_at: '2026-01-01', created_by: 'user' }
  const videoAsset = { ...imageAsset, id: 'video', original_filename: 'video.mp4', public_url: 'https://media.example/video.mp4', mime_type: 'video/mp4', media_type: 'video', width: 1920, height: 1080 }
  const imagePlaceholder = newEditorLayer(scene, 'image', 'new-image', 2)
  const videoPlaceholder = newEditorLayer(scene, 'video', 'new-video', 2)
  const firstImage = layerWithMediaAsset(imagePlaceholder, imageAsset, 'intrinsic')
  const firstVideo = layerWithMediaAsset(videoPlaceholder, videoAsset, 'intrinsic')
  assert.deepEqual({ width: firstImage.width, height: firstImage.height, sourceWidth: firstImage.sourceWidth, sourceHeight: firstImage.sourceHeight }, { width: 413, height: 325, sourceWidth: 413, sourceHeight: 325 })
  assert.deepEqual({ width: firstVideo.width, height: firstVideo.height, sourceWidth: firstVideo.sourceWidth, sourceHeight: firstVideo.sourceHeight }, { width: 1920, height: 1080, sourceWidth: 1920, sourceHeight: 1080 })
  assert.equal(firstImage.content.fit, 'contain')
  assert.equal(firstVideo.content.fit, 'contain')
  const fromWidth = mediaDimensionChange(firstImage, 'width', 826)
  const fromHeight = mediaDimensionChange(firstImage, 'height', 650)
  assert.equal(fromWidth.width, 826)
  assert.ok(Math.abs(fromWidth.height - 650) < 1e-10)
  assert.ok(Math.abs(fromHeight.width - 826) < 1e-10)
  assert.equal(fromHeight.height, 650)
  assert.deepEqual(mediaDimensionChange({ ...firstImage, lockedAspect: false }, 'width', 500), { width: 500 })
  assert.deepEqual(mediaDimensionChange({ ...firstImage, lockedAspect: false }, 'height', 500), { height: 500 })
  const resized = { ...firstImage, x: 222, y: 333, width: 777, height: 444 }
  const replacement = layerWithMediaAsset({ ...resized, content: { ...resized.content, fit: 'cover' } }, { ...imageAsset, id: 'replacement', width: 600, height: 400 }, 'preserve')
  assert.deepEqual({ x: replacement.x, y: replacement.y, width: replacement.width, height: replacement.height }, { x: 222, y: 333, width: 777, height: 444 })
  assert.deepEqual({ sourceWidth: replacement.sourceWidth, sourceHeight: replacement.sourceHeight, aspectRatio: replacement.aspectRatio }, { sourceWidth: 600, sourceHeight: 400, aspectRatio: 1.5 })
  assert.equal(replacement.content.fit, 'cover')
})

test('virtual Fit layer uses targeted device regions in pixel coordinates', () => {
  const regions = [{ deviceId: 'a', x: 0, y: 0, width: 2400, height: 1080 }, { deviceId: 'b', x: 2500, y: 0, width: 1200, height: 1080 }]
  assert.deepEqual(fitVirtualLayerToRegions({ ...layer, target: ['b'] }, regions), { ...layer, target: ['b'], x: 2500, y: 0, width: 1200, height: 1080, rotation: 0, scale: 1 })
})

test('V2 save/reload preserves exact pixel geometry and persistence contract', () => {
  const values = editorSceneSaveValues(scene)
  const reloaded = { ...scene, ...JSON.parse(JSON.stringify(values)) }
  assert.deepEqual(reloaded.layers[0], layer)
  assert.equal(reloaded.geometry_version, 2)
  assert.equal(reloaded.canvas_width_px, 3700)
  assert.equal(reloaded.canvas_height_px, 1080)
  assert.equal(reloaded.wall_geometry_revision, 'revision')
})

test('revision mismatch warns without rewriting canvas or layers', () => {
  const geometry = virtualGeometryForWall(wall, devices)
  const original = structuredClone(scene)
  assert.match(v2WallGeometryWarning(scene, geometry), /Wall geometry has changed/)
  assert.deepEqual(scene, original)
})

test('V1 movement and save payload remain percentage based and version-neutral', () => {
  const v1Layer = { ...layer, coordinateSpace: 'freeform', x: 10, y: 20, width: 30, height: 40 }
  const v1 = { ...scene, geometry_version: 1, canvas_width_px: null, canvas_height_px: null, layers: [v1Layer] }
  const moved = { ...v1Layer, ...moveEditorLayer(v1, v1Layer, { x: 100, y: 50 }, { width: 1000, height: 500 }) }
  const resized = { ...moved, ...mediaDimensionChange(moved, 'width', 35) }
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: 20, y: 30 })
  assert.equal(resized.width, 35)
  assert.equal(resized.height, 40)
  assert.deepEqual(editorLayerRect(v1, v1Layer), { x: 768, y: 864, width: 2304, height: 1728 })
  const values = editorSceneSaveValues({ ...v1, layers: [resized] })
  assert.equal('geometry_version' in values, false)
  const reloaded = { ...v1, ...JSON.parse(JSON.stringify(values)) }
  assert.equal(reloaded.geometry_version, 1)
  assert.deepEqual(reloaded.layers[0], resized)
})
