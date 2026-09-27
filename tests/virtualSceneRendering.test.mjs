import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { clipVirtualProjection, deriveVirtualWallGeometry, parseVirtualWallGeometry, projectVirtualRect, validateV2SceneRender, virtualPlaneTransform } from '../src/lib/virtualWallGeometry.ts'

const region = (deviceId, xPx, yPx, widthPx, heightPx, viewportWidthPx = null, viewportHeightPx = null) => ({ deviceId, xPx, yPx, widthPx, heightPx, viewportWidthPx, viewportHeightPx })
const geometry = (widthPx, heightPx, devices, geometryRevision = 'revision') => ({ status: 'valid', layoutMode: 'resolution', widthPx, heightPx, geometryRevision, virtualPixelsPerMm: null, devices })
const scene = (width, height, overrides = {}) => ({
  id: 'scene', name: 'V2 fixture', duration_seconds: 60, geometry_version: 2,
  canvas_width_px: width, canvas_height_px: height, wall_geometry_revision: 'revision',
  layers: [{ id: 'layer', type: 'image', target: [], space: 'wall', coordinateSpace: 'virtual-pixel', x: 1700, y: 0, width: 500, height: 100, zIndex: 1, content: { url: '/fixture.png' } }],
  ...overrides,
})

test('simple 2x1 regions produce exact shared-plane crop transforms', () => {
  const viewport = { width: 1920, height: 1080 }
  assert.deepEqual(virtualPlaneTransform({ x: 0, y: 0, width: 1920, height: 1080 }, viewport), {
    scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, cssTransform: 'matrix(1, 0, 0, 1, 0, 0)',
  })
  assert.deepEqual(virtualPlaneTransform({ x: 1920, y: 0, width: 1920, height: 1080 }, viewport), {
    scaleX: 1, scaleY: 1, translateX: -1920, translateY: 0, cssTransform: 'matrix(1, 0, 0, 1, -1920, 0)',
  })
})

test('unequal virtual regions are not treated as equal-width screens', () => {
  const a = virtualPlaneTransform({ x: 0, y: 0, width: 2400, height: 1200 }, { width: 1200, height: 600 })
  const b = virtualPlaneTransform({ x: 2400, y: 0, width: 1200, height: 1200 }, { width: 1200, height: 600 })
  assert.equal(a.scaleX, .5)
  assert.equal(b.scaleX, 1)
  assert.equal(b.translateX, -2400)
})

test('runtime output resolution changes raster scale but not virtual footprint', () => {
  const aView = { x: 0, y: 0, width: 2400, height: 1200 }
  const bView = { x: 2400, y: 0, width: 1200, height: 1200 }
  const a = virtualPlaneTransform(aView, { width: 1920, height: 1080 })
  const b = virtualPlaneTransform(bView, { width: 3840, height: 2160 })
  assert.equal(a.scaleX, .8)
  assert.equal(a.scaleY, .9)
  assert.equal(b.scaleX, 3.2)
  assert.equal(b.scaleY, 1.8)
  assert.deepEqual(aView, { x: 0, y: 0, width: 2400, height: 1200 })
  assert.deepEqual(bView, { x: 2400, y: 0, width: 1200, height: 1200 })
})

test('physical PIXEL-01 regions keep a 2:1 footprint with equal-resolution outputs', () => {
  const result = deriveVirtualWallGeometry({ mode: 'physical', virtualPixelsPerMm: 4, devices: [
    { deviceId: 'wide', layoutMode: 'physical', x: 0, y: 0, width: 600, height: 300, viewportWidthPx: 1920, viewportHeightPx: 1080 },
    { deviceId: 'narrow', layoutMode: 'physical', x: 600, y: 0, width: 300, height: 300, viewportWidthPx: 1920, viewportHeightPx: 1080 },
  ] })
  assert.equal(result.status, 'valid')
  assert.equal(result.devices.find(device => device.deviceId === 'wide').widthPx, 2400)
  assert.equal(result.devices.find(device => device.deviceId === 'narrow').widthPx, 1200)
  assert.equal(virtualPlaneTransform({ x: 0, y: 0, width: 2400, height: 1200 }, { width: 1920, height: 1080 }).scaleX, .8)
  assert.equal(virtualPlaneTransform({ x: 2400, y: 0, width: 1200, height: 1200 }, { width: 1920, height: 1080 }).scaleX, 1.6)
})

test('a virtual bezel gap is visible on neither device', () => {
  const gap = { x: 1900, y: 0, width: 100, height: 100 }
  const viewport = { width: 1900, height: 1080 }
  const onA = projectVirtualRect(gap, { x: 0, y: 0, width: 1900, height: 1080 }, viewport)
  const onB = projectVirtualRect(gap, { x: 2000, y: 0, width: 1900, height: 1080 }, viewport)
  assert.equal(clipVirtualProjection(onA, viewport), null)
  assert.equal(clipVirtualProjection(onB, viewport), null)
})

test('one spanning layer joins at the shared A/B boundary', () => {
  const layer = { x: 1700, y: 0, width: 500, height: 100 }
  const viewport = { width: 1920, height: 1080 }
  const onA = projectVirtualRect(layer, { x: 0, y: 0, width: 1920, height: 1080 }, viewport)
  const onB = projectVirtualRect(layer, { x: 1920, y: 0, width: 1920, height: 1080 }, viewport)
  assert.deepEqual(clipVirtualProjection(onA, viewport), { x: 1700, y: 0, width: 220, height: 100 })
  assert.deepEqual(clipVirtualProjection(onB, viewport), { x: 0, y: 0, width: 280, height: 100 })
})

test('normalized negative-source regions are consumed without a second normalization', () => {
  const result = deriveVirtualWallGeometry({ mode: 'resolution', devices: [
    { deviceId: 'a', layoutMode: 'resolution', x: -200, y: -50, width: 100, height: 100 },
    { deviceId: 'b', layoutMode: 'resolution', x: 25, y: 10, width: 100, height: 100 },
  ] })
  assert.equal(result.status, 'valid')
  assert.deepEqual(result.devices.map(({ xPx, yPx }) => ({ xPx, yPx })), [{ xPx: 0, yPx: 0 }, { xPx: 225, yPx: 60 }])
  assert.equal(virtualPlaneTransform({ x: 225, y: 60, width: 100, height: 100 }, { width: 100, height: 100 }).translateX, -225)
})

test('valid V2 contract requires matching canvas, revision, device region, and wall-pixel layers', () => {
  const wall = geometry(3840, 1080, [region('a', 0, 0, 1920, 1080), region('b', 1920, 0, 1920, 1080)])
  assert.equal(validateV2SceneRender(scene(3840, 1080), wall, 'b').status, 'valid')
  assert.equal(validateV2SceneRender(scene(3840, 1080), wall, 'missing').reason, 'missing-current-device-region')
  assert.equal(validateV2SceneRender(scene(3840, 1080, { canvas_width_px: null }), wall, 'a').reason, 'missing-or-invalid-canvas')
  assert.equal(validateV2SceneRender(scene(3840, 1080, { wall_geometry_revision: 'stale' }), wall, 'a').reason, 'wall-geometry-revision-mismatch')
  assert.equal(validateV2SceneRender(scene(3840, 1080, { layers: [{ ...scene(1, 1).layers[0], coordinateSpace: 'freeform' }] }), wall, 'a').reason, 'unsupported-layer-geometry:layer')
})

test('malformed player geometry is rejected and invalid server results remain explicit', () => {
  assert.equal(parseVirtualWallGeometry({ status: 'valid', widthPx: 100 }), null)
  assert.deepEqual(parseVirtualWallGeometry({ status: 'invalid', reason: 'mixed-layout-units' }), { status: 'invalid', reason: 'mixed-layout-units' })
  assert.equal(parseVirtualWallGeometry({ status: 'invalid', reason: 'unexpected' }), null)
})

test('renderer keeps explicit V1 percentages and V2 pixel mode', () => {
  const layerSource = readFileSync(new URL('../src/rendering/Layer.tsx', import.meta.url), 'utf8')
  const previewSource = readFileSync(new URL('../src/rendering/ScenePreview.tsx', import.meta.url), 'utf8')
  assert.match(layerSource, /geometryMode === 'virtual-pixel' \? 'px' : '%'/)
  assert.match(previewSource, /sceneGeometryVersion\(props\.scene\) === 2 \? <V2ScenePreview/)
  assert.match(previewSource, /function V1ScenePreview/)
  assert.match(previewSource, /planeTransform\(reference, player && !current \? reference : view/)
})
