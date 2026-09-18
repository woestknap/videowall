import test from 'node:test'
import assert from 'node:assert/strict'
import { WORKSPACE, bounds, deviceRect, layerReference, toWorkspaceLayer, planeTransform, fitLayerToDevices } from '../src/lib/wallGeometry.ts'
import { panForCursorZoom } from '../src/lib/editorZoom.ts'

const device = (id, x, y, width = 800, height = 480) => ({ id, layout_x: x, layout_y: y, layout_width: width, layout_height: height })
const four = [device('tl', 0, 0), device('tr', 800, 0), device('bl', 0, 480), device('br', 800, 480)]
const layer = { id: 'image', space: 'wall', coordinateSpace: 'freeform', x: 300 / 7680 * 100, y: 100 / 4320 * 100, width: 1300 / 7680 * 100, height: 800 / 4320 * 100, target: [], content: {} }
const scene = { layers: [layer], device_ids: [] }
const matrix = (...args) => planeTransform(...args).slice(7, -1).split(',').map(Number)
const point = (m, x, y) => [m[0] * x + m[4], m[3] * y + m[5]]
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`)

test('1300×800 media remains larger than an 800×480 display; bottom-right sees the correct slice', () => {
  const m = matrix(WORKSPACE, deviceRect(four[3]), 800, 480)
  assert.deepEqual(point(m, 300, 100), [-500, -380])
  close(m[0] * layer.width / 100 * 7680, 1300)
  close(m[3] * layer.height / 100 * 4320, 800)
})

test('150×85 mm Pi and 600×337.5 mm 1080p TV preserve physical coordinates across their edge', () => {
  const pi = deviceRect(device('pi', 0, 0, 150, 85))
  const tv = deviceRect(device('tv', 150, 0, 600, 337.5))
  const pm = matrix(WORKSPACE, pi, 800, 480), tm = matrix(WORKSPACE, tv, 1920, 1080)
  close(point(pm, 150, 40)[0], 800)
  close(point(tm, 150, 40)[0], 0)
  close(point(pm, 150, 40)[1] / 480 * 85, 40)
  close(point(tm, 150, 40)[1] / 1080 * 337.5, 40)
})

test('negative positions and bezel gaps hide the correct portion of the wall', () => {
  const view = deviceRect(device('right', 160, -20, 150, 85))
  const m = matrix(WORKSPACE, view, 800, 480)
  close(point(m, 160, -20)[0], 0)
  close(point(m, 160, -20)[1], 0)
  assert.ok(point(m, 155, 0)[0] < 0) // 10 mm gap after the left 150 mm screen
})

test('legacy scenes retain their bounds and editor conversion preserves layer coordinates', () => {
  const old = { ...layer, coordinateSpace: 'legacy', x: 25, y: 25, width: 50, height: 50 }
  const ref = layerReference(old, scene, four)
  assert.deepEqual(ref, { x: 0, y: 0, width: 1600, height: 960 })
  const converted = toWorkspaceLayer(old, scene, four)
  close(converted.x / 100 * 7680, 400)
  close(converted.y / 100 * 4320, 240)
  close(converted.width / 100 * 7680, 800)
  close(converted.height / 100 * 4320, 480)
})

test('screen-local layers and targeted fit use the intended displays only', () => {
  assert.deepEqual(layerReference({ ...layer, space: 'screen' }, scene, four, four[2]), deviceRect(four[2]))
  const fit = fitLayerToDevices({ ...layer, target: ['tr', 'br'] }, four)
  close(fit.x / 100 * 7680, 800)
  close(fit.width / 100 * 7680, 800)
  close(fit.height / 100 * 4320, 960)
  assert.deepEqual(bounds([deviceRect(device('a', -100, -50, 150, 85))]), { x: -100, y: -50, width: 150, height: 85 })
})

test('wheel zoom keeps the cursor workspace coordinate fixed', () => {
  const stage = { left: 100, top: 200, width: 800, height: 450 }
  const pan = panForCursorZoom({ pan: { x: 40, y: -25 }, zoom: 2, nextZoom: 3, stage, cursor: { x: 300, y: 425 } })
  // At 25% across and 50% down, the point remains at the same screen position.
  close(pan.x, 140)
  close(pan.y, -25)
  assert.deepEqual(panForCursorZoom({ pan, zoom: 0, nextZoom: 3, stage, cursor: { x: 300, y: 425 } }), pan)
})
