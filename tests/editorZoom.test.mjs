import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceWorkspaceDrag, clientPointToWorkspace, deltaClientToWorkspace, devicePositionChange, displayedZoomPercent, fitEditorView, MAX_EDITOR_ZOOM, MIN_EDITOR_ZOOM, nudgeDevicePosition, stageGeometryFromRect, startWorkspaceDrag, workspacePointToClient, workspaceRectToClientRect, zoomAroundCursor, zoomFromWheel } from '../src/lib/editorZoom.ts'

const wall = { width: 7680, height: 4320 }
const stage = { center: { x: 700, y: 450 }, width: 1000, height: 562.5 }
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)
const closePoint = (actual, expected) => { close(actual.x, expected.x); close(actual.y, expected.y) }
const transformedRect = view => ({
  left: stage.center.x + view.pan.x - stage.width * view.zoom / 2,
  top: stage.center.y + view.pan.y - stage.height * view.zoom / 2,
  width: stage.width * view.zoom,
  height: stage.height * view.zoom,
})

test('transformed stage rect is converted back to stable layout geometry', () => {
  for (const zoom of [.2, .5, 1, 4, 128]) {
    const view = { zoom, pan: { x: -142.75, y: 89.125 } }
    const geometry = stageGeometryFromRect(transformedRect(view), view)
    closePoint(geometry.center, stage.center)
    close(geometry.width, stage.width)
    close(geometry.height, stage.height)
  }
})

test('cursor anchored zoom preserves the same workspace point under the cursor', () => {
  const cursor = { x: 354.125, y: 692.375 }
  for (const zoom of [.2, .5, 1, 4, 32]) {
    const view = { zoom, pan: { x: 72.25, y: -39.5 } }
    const geometry = stageGeometryFromRect(transformedRect(view), view)
    const before = clientPointToWorkspace(cursor, view, geometry, wall)
    for (const requested of [.01, .35, 1.07, 4, 400]) {
      const next = zoomAroundCursor(view, requested, geometry, cursor, wall)
      closePoint(clientPointToWorkspace(cursor, next, geometry, wall), before)
      closePoint(workspacePointToClient(before, next, geometry, wall), cursor)
      assert.ok(next.zoom >= MIN_EDITOR_ZOOM && next.zoom <= MAX_EDITOR_ZOOM)
    }
  }
})

test('client and workspace points round trip with pan, zoom, and fractional positions', () => {
  const point = { x: 153.125, y: -17.875 }
  const view = { zoom: 3.75, pan: { x: 127.5, y: -91.25 } }
  closePoint(clientPointToWorkspace(workspacePointToClient(point, view, stage, wall), view, stage, wall), point)
})

test('workspace rectangles map to client pixels at zoom 1', () => {
  const rect = workspaceRectToClientRect({ x: 768, y: 432, width: 1536, height: 864 }, { zoom: 1, pan: { x: 0, y: 0 } }, stage, wall)
  assert.deepEqual(rect, { left: 300, top: 225, width: 200, height: 112.5 })
})

test('workspace rectangle position and size share the stage zoom transform', () => {
  const model = { x: 768, y: 432, width: 1536, height: 864 }
  const atOne = workspaceRectToClientRect(model, { zoom: 1, pan: { x: 0, y: 0 } }, stage, wall)
  const atFour = workspaceRectToClientRect(model, { zoom: 4, pan: { x: 0, y: 0 } }, stage, wall)
  assert.deepEqual(atFour, { left: -900, top: -450, width: 800, height: 450 })
  assert.equal(atFour.width, atOne.width * 4)
  assert.equal(atFour.height, atOne.height * 4)
})

test('pan offsets every guide edge without changing guide size', () => {
  const model = { x: 153.125, y: -17.875, width: 600.5, height: 337.75 }
  const still = workspaceRectToClientRect(model, { zoom: 2, pan: { x: 0, y: 0 } }, stage, wall)
  const panned = workspaceRectToClientRect(model, { zoom: 2, pan: { x: 37.25, y: -18.5 } }, stage, wall)
  close(panned.left - still.left, 37.25)
  close(panned.top - still.top, -18.5)
  close(panned.left + panned.width - (still.left + still.width), 37.25)
  close(panned.top + panned.height - (still.top + still.height), -18.5)
  close(panned.width, still.width)
  close(panned.height, still.height)
  assert.notEqual(panned.left, Math.round(panned.left))
})

test('client guide edges agree with transformed workspace object points', () => {
  const model = { x: 153.125, y: -17.875, width: 600.5, height: 337.75 }
  const view = { zoom: 3.75, pan: { x: 127.5, y: -91.25 } }
  const rect = workspaceRectToClientRect(model, view, stage, wall)
  closePoint({ x: rect.left, y: rect.top }, workspacePointToClient({ x: model.x, y: model.y }, view, stage, wall))
  closePoint({ x: rect.left + rect.width, y: rect.top + rect.height }, workspacePointToClient({ x: model.x + model.width, y: model.y + model.height }, view, stage, wall))
  assert.deepEqual(Object.keys(rect), ['left', 'top', 'width', 'height']) // border thickness is not geometry
})

test('device and both layer drag spaces use zoom corrected continuous deltas', () => {
  const device = { width: 150, height: 85 }
  const clientDelta = { x: 25, y: -12.5 }
  for (const zoom of [.5, 1, 4]) {
    const world = deltaClientToWorkspace(clientDelta, zoom, stage, wall)
    close(world.x * zoom, 192)
    close(world.y * zoom, -96)
    close(world.x / device.width * 100 * zoom, 128) // screen-space layer percentage
    close(world.x / wall.width * 100 * zoom, 2.5) // wall-space layer percentage
    const fine = deltaClientToWorkspace({ x: clientDelta.x * .1, y: clientDelta.y * .1 }, zoom, stage, wall)
    close(fine.x, world.x * .1)
    close(fine.y, world.y * .1)
    assert.notEqual(153.125 + fine.x, Math.round(153.125 + fine.x)) // fractional placement is not rounded
  }
})

test('device drag uses its pointer-down origin, independent of screen and label dimensions', () => {
  const start = { x: 153.125, y: -17.875 }
  const pointer = { x: 520, y: 340 }
  const smallDevice = { width: 150, height: 85 }
  const largeDevice = { width: 1920, height: 1080 }
  const measuredStage = { width: stage.width, height: stage.height }
  const small = startWorkspaceDrag(pointer, start, 1, measuredStage, wall)
  const large = startWorkspaceDrag(pointer, start, 1, stage, wall)
  // Moving boxes and labels can change their rectangles; the captured scale stays fixed.
  smallDevice.width = 10
  largeDevice.width = 5000
  measuredStage.width = 10
  const end = { x: pointer.x + 25.25, y: pointer.y - 12.5 }
  const smallResult = advanceWorkspaceDrag(small, end, false).position
  const largeResult = advanceWorkspaceDrag(large, end, false).position
  closePoint(smallResult, largeResult)
  closePoint(smallResult, { x: start.x + 25.25 / stage.width * wall.width, y: start.y - 12.5 / stage.height * wall.height })
  assert.notEqual(smallResult.x, Math.round(smallResult.x))
})

test('50%, 100%, 200%, and 400% drags have the same workspace displacement for equivalent stage movement', () => {
  const pointer = { x: 520, y: 340 }
  for (const zoom of [.5, 1, 2, 4]) {
    const drag = startWorkspaceDrag(pointer, { x: 12.5, y: -3.25 }, zoom, stage, wall)
    const { position } = advanceWorkspaceDrag(drag, { x: pointer.x + 25 * zoom, y: pointer.y - 12.5 * zoom }, false)
    closePoint(position, { x: 12.5 + 25 / stage.width * wall.width, y: -3.25 - 12.5 / stage.height * wall.height })
  }
})

test('Shift has one tenth sensitivity without a jump when toggled mid-drag', () => {
  const pointer = { x: 500, y: 300 }
  let state = startWorkspaceDrag(pointer, { x: 0, y: 0 }, 1, stage, wall)
  const normal = advanceWorkspaceDrag(state, { x: 520, y: 300 }, false)
  state = normal.drag
  const toggle = advanceWorkspaceDrag(state, { x: 520, y: 300 }, true)
  closePoint(toggle.position, normal.position)
  const fine = advanceWorkspaceDrag(toggle.drag, { x: 540, y: 300 }, true)
  close(fine.position.x - normal.position.x, normal.position.x * .1)
  const release = advanceWorkspaceDrag(fine.drag, { x: 540, y: 300 }, false)
  closePoint(release.position, fine.position)
  const resumed = advanceWorkspaceDrag(release.drag, { x: 560, y: 300 }, false)
  close(resumed.position.x - release.position.x, normal.position.x)
})

test('many pointer moves and a return to origin do not accumulate layout drift', () => {
  const pointer = { x: 410.25, y: 211.75 }
  const initial = { x: 153.125, y: -17.875 }
  const origin = startWorkspaceDrag(pointer, initial, .5, stage, wall)
  let state = origin
  for (let index = 1; index <= 1000; index += 1) {
    state = advanceWorkspaceDrag(state, { x: pointer.x + index * .013, y: pointer.y - index * .017 }, false).drag
  }
  const end = { x: pointer.x + 13, y: pointer.y - 17 }
  closePoint(advanceWorkspaceDrag(state, end, false).position, advanceWorkspaceDrag(origin, end, false).position)
  closePoint(advanceWorkspaceDrag(state, pointer, false).position, initial)
})

test('releasing and grabbing the device again preserves its position', () => {
  const first = startWorkspaceDrag({ x: 100, y: 100 }, { x: 12.125, y: 8.375 }, 2, stage, wall)
  const placed = advanceWorkspaceDrag(first, { x: 140, y: 110 }, false).position
  const second = startWorkspaceDrag({ x: 140, y: 110 }, placed, 2, stage, wall)
  closePoint(advanceWorkspaceDrag(second, { x: 140, y: 110 }, false).position, placed)
  const moved = advanceWorkspaceDrag(second, { x: 145, y: 110 }, false).position
  close(moved.x - placed.x, 5 / (stage.width * 2) * wall.width)
})

test('pan moves in client pixels independently of zoom', () => {
  const worldPoint = { x: 100, y: 70 }
  for (const zoom of [.25, 1, 4]) {
    const view = { zoom, pan: { x: 0, y: 0 } }
    const moved = { zoom, pan: { x: 37.25, y: -18.5 } }
    const before = workspacePointToClient(worldPoint, view, stage, wall)
    const after = workspacePointToClient(worldPoint, moved, stage, wall)
    closePoint({ x: after.x - before.x, y: after.y - before.y }, moved.pan)
  }
})

test('wheel and trackpad zoom are bounded and finer than the old steps', () => {
  close(zoomFromWheel(1, -100), 1.07)
  close(zoomFromWheel(1, 100), 1 / 1.07)
  assert.ok(zoomFromWheel(1, -2) > 1 && zoomFromWheel(1, -2) < 1.01)
  close(zoomFromWheel(1, -10000), 1.07)
  close(zoomFromWheel(1, -3, 1), zoomFromWheel(1, -48))
  close(zoomFromWheel(MIN_EDITOR_ZOOM, 10000), MIN_EDITOR_ZOOM)
  close(zoomFromWheel(MAX_EDITOR_ZOOM, -10000), MAX_EDITOR_ZOOM)
})

test('fit screens centers active device bounds regardless of prior view', () => {
  const bounds = { x: -150, y: 12.5, width: 750, height: 337.5 }
  const fitted = fitEditorView({ bounds, workspace: { width: 900, height: 600 }, stage: { width: 1000, height: 562.5 }, wall })
  assert.ok(fitted)
  const center = workspacePointToClient({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, fitted, { center: { x: 450, y: 300 }, width: 1000, height: 562.5 }, wall)
  closePoint(center, { x: 450, y: 300 })
  const overlay = workspaceRectToClientRect(bounds, fitted, { center: { x: 450, y: 300 }, width: 1000, height: 562.5 }, wall)
  closePoint({ x: overlay.left + overlay.width / 2, y: overlay.top + overlay.height / 2 }, { x: 450, y: 300 })
  assert.equal(displayedZoomPercent(fitted.zoom, fitted.zoom), 100)
  assert.ok(fitted.zoom >= MIN_EDITOR_ZOOM && fitted.zoom <= MAX_EDITOR_ZOOM)
  assert.equal(fitEditorView({ bounds, workspace: { width: 0, height: 600 }, stage: { width: 1000, height: 562.5 }, wall }), null)
})

test('displayed zoom is relative to the current fitted baseline', () => {
  const fitZoom = 3.84
  assert.equal(displayedZoomPercent(fitZoom, fitZoom), 100)
  assert.equal(displayedZoomPercent(fitZoom * 1.25, fitZoom), 125)
  assert.equal(displayedZoomPercent(fitZoom * .5, fitZoom), 50)
})

test('device drag produces a position-only decimal update', () => {
  const device = { layout_x: 12.125, layout_y: 8.375, layout_width: 150, layout_height: 85 }
  const drag = startWorkspaceDrag({ x: 100, y: 100 }, { x: device.layout_x, y: device.layout_y }, 2, stage, wall)
  const position = advanceWorkspaceDrag(drag, { x: 103.25, y: 98.75 }, false).position
  const change = devicePositionChange(position)
  const moved = { ...device, ...change }

  assert.deepEqual(Object.keys(change).sort(), ['layout_x', 'layout_y'])
  assert.equal(moved.layout_width, device.layout_width)
  assert.equal(moved.layout_height, device.layout_height)
  assert.notEqual(moved.layout_x, Math.round(moved.layout_x))
  assert.notEqual(moved.layout_y, Math.round(moved.layout_y))
})

test('keyboard nudges use exact one-unit and Shift fine increments', () => {
  const start = { x: 10.25, y: -4.75 }
  assert.deepEqual(nudgeDevicePosition(start, 'ArrowLeft', false), { x: 9.25, y: -4.75 })
  assert.deepEqual(nudgeDevicePosition(start, 'ArrowRight', true), { x: 10.35, y: -4.75 })
  assert.deepEqual(nudgeDevicePosition(start, 'ArrowUp', true), { x: 10.25, y: -4.85 })
  assert.deepEqual(nudgeDevicePosition(start, 'ArrowDown', false), { x: 10.25, y: -3.75 })
})
