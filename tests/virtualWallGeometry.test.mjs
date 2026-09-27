import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { deriveVirtualWallGeometry, sceneGeometryVersion, wallGeometryRevision } from '../src/lib/virtualWallGeometry.ts'

const resolutionDevice = (deviceId, x, y, width, height, overrides = {}) => ({
  deviceId,
  layoutMode: 'resolution',
  x, y, width, height,
  viewportWidthPx: width,
  viewportHeightPx: height,
  ...overrides,
})

const physicalDevice = (deviceId, x, y, width, height, viewportWidthPx, viewportHeightPx, overrides = {}) => ({
  deviceId,
  layoutMode: 'physical',
  x, y, width, height,
  viewportWidthPx,
  viewportHeightPx,
  ...overrides,
})

const valid = result => {
  assert.equal(result.status, 'valid')
  return result
}

test('existing scenes default to V1 without reinterpreting layer coordinates', () => {
  const layer = { x: 8, y: 12, width: 84, height: 40 }
  assert.equal(sceneGeometryVersion({}), 1)
  assert.equal(sceneGeometryVersion({ geometry_version: 1 }), 1)
  assert.deepEqual(layer, { x: 8, y: 12, width: 84, height: 40 })
})

test('same-size resolution displays form one normalized tiled pixel wall', () => {
  const geometry = valid(deriveVirtualWallGeometry({
    mode: 'resolution',
    devices: [resolutionDevice('left', 0, 0, 1920, 1080), resolutionDevice('right', 1920, 0, 1920, 1080)],
  }))
  assert.equal(geometry.widthPx, 3840)
  assert.equal(geometry.heightPx, 1080)
  assert.deepEqual(geometry.devices.map(({ deviceId, xPx, widthPx }) => ({ deviceId, xPx, widthPx })), [
    { deviceId: 'left', xPx: 0, widthPx: 1920 },
    { deviceId: 'right', xPx: 1920, widthPx: 1920 },
  ])
})

test('resolution geometry preserves unequal sizes, gaps, fractions, and negative offsets', () => {
  const geometry = valid(deriveVirtualWallGeometry({
    mode: 'resolution',
    devices: [resolutionDevice('a', -100.5, -20.25, 1920, 1080), resolutionDevice('b', 1829.75, 10.25, 1280, 1024)],
  }))
  const [a, b] = geometry.devices
  assert.equal(a.xPx, 0)
  assert.equal(a.yPx, 0)
  assert.equal(b.xPx, 1930.25)
  assert.equal(b.yPx, 30.5)
  assert.equal(b.widthPx, 1280)
  assert.equal(b.heightPx, 1024)
  assert.equal(b.xPx - (a.xPx + a.widthPx), 10.25)
  assert.equal(geometry.widthPx, 3210.25)
  assert.equal(geometry.heightPx, 1080)
})

test('one physical scale preserves unequal physical footprints independently of equal viewport resolution', () => {
  const geometry = valid(deriveVirtualWallGeometry({
    mode: 'physical',
    virtualPixelsPerMm: 2,
    devices: [
      physicalDevice('large', -600, -10, 600, 340, 1920, 1080),
      physicalDevice('small', 10, 0, 300, 170, 1920, 1080),
    ],
  }))
  const large = geometry.devices.find(device => device.deviceId === 'large')
  const small = geometry.devices.find(device => device.deviceId === 'small')
  assert.equal(large.widthPx, 1200)
  assert.equal(small.widthPx, 600)
  assert.equal(large.widthPx / small.widthPx, 2)
  assert.equal(large.heightPx / small.heightPx, 2)
  assert.equal(small.xPx - (large.xPx + large.widthPx), 20)
  assert.equal(large.yPx, 0)
  assert.equal(small.yPx, 20)
})

test('physical footprint and revision ignore runtime viewport density', () => {
  const lowDensity = [physicalDevice('a', 0, 0, 600, 337.5, 1920, 1080), physicalDevice('b', 610, 0, 600, 337.5, 1920, 1080)]
  const mixedDensity = [physicalDevice('a', 0, 0, 600, 337.5, 1920, 1080), physicalDevice('b', 610, 0, 600, 337.5, 3840, 2160)]
  const first = valid(deriveVirtualWallGeometry({ mode: 'physical', virtualPixelsPerMm: 3.2, devices: lowDensity }))
  const second = valid(deriveVirtualWallGeometry({ mode: 'physical', virtualPixelsPerMm: 3.2, devices: mixedDensity }))
  assert.deepEqual(first.devices.map(device => [device.xPx, device.yPx, device.widthPx, device.heightPx]), second.devices.map(device => [device.xPx, device.yPx, device.widthPx, device.heightPx]))
  assert.equal(first.geometryRevision, second.geometryRevision)
  assert.equal(second.devices[1].viewportWidthPx, 3840)
})

test('mixed layout units and invalid physical calibration are explicit failures', () => {
  assert.deepEqual(deriveVirtualWallGeometry({ mode: 'resolution', devices: [resolutionDevice('a', 0, 0, 100, 100), physicalDevice('b', 100, 0, 100, 100, 800, 480)] }), { status: 'invalid', reason: 'mixed-layout-units' })
  assert.deepEqual(deriveVirtualWallGeometry({ mode: 'physical', virtualPixelsPerMm: 0, devices: [physicalDevice('a', 0, 0, 100, 100, 800, 480)] }), { status: 'invalid', reason: 'invalid-calibration' })
})

test('geometry revision is stable, order independent, and changes only for geometry inputs', () => {
  const devices = [resolutionDevice('b', 1920, 0, 1280, 1024), resolutionDevice('a', 0, 0, 1920, 1080)]
  const sameWithMetadata = devices.map(device => ({ ...device, name: 'ignored', viewportWidthPx: 999, viewportHeightPx: 777 }))
  const revision = wallGeometryRevision('resolution', devices)
  assert.equal(wallGeometryRevision('resolution', [...devices].reverse()), revision)
  assert.equal(wallGeometryRevision('resolution', sameWithMetadata), revision)
  assert.notEqual(wallGeometryRevision('resolution', devices.map((device, index) => index ? device : { ...device, x: device.x + 1 })), revision)
  assert.notEqual(wallGeometryRevision('resolution', devices.map((device, index) => index ? device : { ...device, width: device.width + 1 })), revision)
  const physical = devices.map(device => ({ ...device, layoutMode: 'physical' }))
  assert.notEqual(wallGeometryRevision('physical', physical, 2), revision)
  assert.notEqual(wallGeometryRevision('physical', physical, 2), wallGeometryRevision('physical', physical, 2.1))
})

test('unequal physical screens and a bezel gap share one continuous virtual plane', () => {
  const geometry = valid(deriveVirtualWallGeometry({
    mode: 'physical',
    virtualPixelsPerMm: 4,
    devices: [
      physicalDevice('wide', 0, 0, 600, 337.5, 1920, 1080),
      physicalDevice('small', 612, 40, 300, 170, 1280, 720),
    ],
  }))
  const wide = geometry.devices.find(device => device.deviceId === 'wide')
  const small = geometry.devices.find(device => device.deviceId === 'small')
  assert.equal(wide.widthPx, 2400)
  assert.equal(small.widthPx, 1200)
  assert.equal(small.xPx - (wide.xPx + wide.widthPx), 48)
  assert.equal(small.yPx, 160)
  assert.equal(geometry.widthPx, small.xPx + small.widthPx)
})

test('database migration keeps the V1 player contract and adds optional V2 fields', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260927190000_virtual_pixel_geometry_contract.sql', import.meta.url), 'utf8')
  assert.match(sql, /geometry_version smallint not null default 1/)
  assert.match(sql, /wall_id uuid references public\.walls\(id\) on delete set null/)
  assert.doesNotMatch(sql, /update public\.scenes[\s\S]*wall_id/i)
  for (const field of ['devices', 'scene_started_at', 'live_session', 'layers', 'duration_seconds', 'device_ids']) assert.match(sql, new RegExp(`'${field}'`))
  for (const field of ['virtual_wall_geometry', 'geometry_version', 'canvas_width_px', 'canvas_height_px', 'wall_geometry_revision']) assert.match(sql, new RegExp(`'${field}'`))
})
