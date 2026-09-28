import assert from 'node:assert/strict'
import test from 'node:test'
import { liveSourceIdForLayer, liveSourcesForLayers, sourceLayersRemain } from '../src/lib/liveSources.ts'

const devices = [{ id: 'one' }, { id: 'two' }, { id: 'three' }]
const live = (id, source, name, target = []) => ({ id, type: 'live', target, x: 0, y: 0, width: 1, height: 1, zIndex: 1, content: { liveSourceId: source, ...(name ? { liveSourceName: name } : {}) } })

test('live source list deduplicates shared layers with stable fallback names and target unions', () => {
  const sources = liveSourcesForLayers([live('a1', 'a', 'Presenter camera', ['one']), live('a2', 'a', '', ['two']), live('b', 'b', '', [])], devices)
  assert.equal(sources.length, 2)
  assert.deepEqual(sources[0], { id: 'a', name: 'Presenter camera', layerIds: ['a1', 'a2'], targetDeviceIds: ['one', 'two'] })
  assert.deepEqual(sources[1].targetDeviceIds, ['one', 'two', 'three'])
  assert.equal(sources[1].name, 'Live source 2')
})

test('removing one shared layer keeps its source while removing the final layer releases only that source', () => {
  const layers = [live('a1', 'a'), live('a2', 'a'), live('b', 'b')]
  assert.equal(sourceLayersRemain(layers, 'a', 'a1'), true)
  assert.equal(sourceLayersRemain(layers, 'a', 'a2'), true)
  assert.equal(sourceLayersRemain(layers, 'b', 'b'), false)
})

test('selecting any shared live layer resolves its source while non-live layers do not change source focus', () => {
  assert.equal(liveSourceIdForLayer(live('a1', 'shared')), 'shared')
  assert.equal(liveSourceIdForLayer({ id: 'image', type: 'image', content: {} }), null)
})
