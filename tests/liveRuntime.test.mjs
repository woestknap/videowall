import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveSessionRegistry, liveSessionKey, removeLiveStream } from '../src/lib/liveRuntime.ts'
import { readFileSync } from 'node:fs'

test('source/device session identities coexist without collisions', () => {
  const registry = new LiveSessionRegistry()
  const a1 = { liveSourceId: 'source-a', deviceId: 'pi-1' }
  const b1 = { liveSourceId: 'source-b', deviceId: 'pi-1' }
  const a2 = { liveSourceId: 'source-a', deviceId: 'pi-2' }
  registry.set(a1, 'a1'); registry.set(b1, 'b1'); registry.set(a2, 'a2')
  assert.equal(new Set([liveSessionKey(a1), liveSessionKey(b1), liveSessionKey(a2)]).size, 3)
  assert.equal(registry.get(a1), 'a1')
  assert.equal(registry.get(b1), 'b1')
  assert.equal(registry.get(a2), 'a2')
})

test('source target changes and source stop leave independent sessions alive', () => {
  const registry = new LiveSessionRegistry()
  const a1 = { liveSourceId: 'a', deviceId: 'pi-1' }
  const a2 = { liveSourceId: 'a', deviceId: 'pi-2' }
  const b1 = { liveSourceId: 'b', deviceId: 'pi-1' }
  registry.set(a1, 'a1'); registry.set(a2, 'a2'); registry.set(b1, 'b1')
  registry.delete(a1)
  assert.equal(registry.get(b1), 'b1')
  assert.equal(registry.get(a2), 'a2')
  assert.deepEqual(registry.clearSource('a').map(entry => entry.value), ['a2'])
  assert.equal(registry.get(b1), 'b1')
})

test('player stream registry removes one source without removing another', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const streams = new Map([['a', a], ['b', b]])
  const after = removeLiveStream(streams, 'a')
  assert.equal(after.has('a'), false)
  assert.equal(after.get('b'), b)
})

test('editor and player use source-scoped runtime state while signaling stays scoped', () => {
  const editor = readFileSync(new URL('../src/editor/SceneEditorPage.tsx', import.meta.url), 'utf8')
  const player = readFileSync(new URL('../src/player/Player.tsx', import.meta.url), 'utf8')
  assert.match(editor, /LiveSessionRegistry<TargetRuntime>/)
  assert.match(editor, /cameraStreamsRef\.current\.get\(runtime\.liveSourceId\)/)
  assert.match(editor, /message\.liveSourceId !== runtime\.liveSourceId/)
  assert.match(player, /live_sessions/)
  assert.match(player, /PlayerLiveSession/)
  assert.match(player, /message\.liveSourceId !== scope\.liveSourceId/)
})
