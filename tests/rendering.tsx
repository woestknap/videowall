// Dev-only fixture: real production renderer and editor media, no backend writes.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ScenePreview, EditorMedia } from '../src/App'
import { ScreenLayoutControls } from '../src/ScreenLayoutControls'
import type { Device, Scene } from '../src/types'
import '../src/styles.css'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1300" height="800" viewBox="0 0 1300 800"><rect width="1300" height="800" fill="#071f36"/><path d="M0 0H650V400H0Z" fill="#f26049"/><path d="M650 0H1300V400H650Z" fill="#e7bc37"/><path d="M0 400H650V800H0Z" fill="#27a3a1"/><path d="M650 400H1300V800H650Z" fill="#705ada"/><path d="M0 0L1300 800M1300 0L0 800" stroke="white" stroke-width="10"/><circle cx="650" cy="400" r="170" fill="none" stroke="white" stroke-width="10"/></svg>`
const url = `data:image/svg+xml,${encodeURIComponent(svg)}`
const devices: Device[] = ['tl', 'tr', 'bl', 'br'].map((id, i) => ({ id, name: id, wall_id: 'test', last_seen_at: null, width: 800, height: 480, layout_x: i % 2 * 800, layout_y: Math.floor(i / 2) * 480, layout_width: 800, layout_height: 480 }))
const scene: Scene = { id: 'test', name: 'Spanning image', duration_seconds: 60, layers: [{ id: 'image', type: 'image', space: 'wall', coordinateSpace: 'freeform', target: [], x: 300 / 7680 * 100, y: 100 / 4320 * 100, width: 1300 / 7680 * 100, height: 800 / 4320 * 100, zIndex: 1, content: { url } }] }
const mixed: Device[] = [{ ...devices[0], auto_size: false, layout_x: 0, layout_y: 0, layout_width: 150, layout_height: 85 }, { ...devices[1], auto_size: false, width: 1920, height: 1080, layout_x: 160, layout_y: 0, layout_width: 600, layout_height: 337.5 }]
const mixedScene: Scene = { ...scene, layers: [{ ...scene.layers[0], x: 0, y: 0, width: 760 / 7680 * 100, height: 400 / 4320 * 100, rotation: 17, scale: 1.1, content: { url, fit: 'contain' } }] }

function Fixture() {
  const [results, setResults] = useState('Checking…')
  const [screen, setScreen] = useState(devices[0])
  useEffect(() => {
    const timer = setTimeout(() => {
      const failures: string[] = []
      const expected = [[150, 50], [-250, 50], [150, -190], [-250, -190]]
      document.querySelectorAll<HTMLElement>('[data-pi]').forEach((panel, i) => {
        const image = panel.querySelector('img')!
        const p = panel.getBoundingClientRect(), m = image.getBoundingClientRect()
        if (Math.abs(m.width - 650) > .1 || Math.abs(m.height - 400) > .1) failures.push(`Screen ${i}: spanning media resized`)
        if (Math.abs(m.left - p.left - expected[i][0]) > .1 || Math.abs(m.top - p.top - expected[i][1]) > .1) failures.push(`Screen ${i}: wrong crop`)
      })
      const editor = document.querySelector<HTMLElement>('[data-editor] img')!.getBoundingClientRect()
      if (Math.abs(editor.width - 650) > .1 || Math.abs(editor.height - 400) > .1) failures.push('Editor selected border changes content size')
      const mixedImages = [...document.querySelectorAll<HTMLElement>('[data-mixed] img')]
      if (mixedImages.some(image => getComputedStyle(image).objectFit !== 'contain')) failures.push('Mixed-screen fit is inconsistent')
      // Explicit transformed bounds for 17-degree rotation BEFORE mapping density.
      const angle = 17 * Math.PI / 180
      const worldWidth = 1.1 * (760 * Math.cos(angle) + 400 * Math.sin(angle))
      const worldHeight = 1.1 * (760 * Math.sin(angle) + 400 * Math.cos(angle))
      mixedImages.forEach((image, i) => {
        const rect = image.getBoundingClientRect(), device = mixed[i]
        if (Math.abs(rect.width - worldWidth * device.width! / device.layout_width!) > .2 || Math.abs(rect.height - worldHeight * device.height! / device.layout_height!) > .2) failures.push('Rotation was applied after pixel-density scaling')
      })
      const hidden = document.querySelector('[data-excluded] img')
      if (hidden) failures.push('Excluded device still renders media')
      const videos = [...document.querySelectorAll<HTMLElement>('[data-video] video')]
      if (videos.length !== 2 || videos.some(v => Math.abs(v.getBoundingClientRect().width - 650) > .1)) failures.push('Video paths shrink the spanning layer')
      setResults(failures.length ? failures.join('\n') : 'PASS: four-screen crops, editor dimensions, mixed pixel densities, rotated contain, excluded display, native and synced video dimensions')
    }, 1800)
    return () => clearTimeout(timer)
  }, [])
  const layer = scene.layers[0]
  return <main style={{ padding: 20 }}>
    <h1 style={{ fontSize: 28 }}>Wall rendering regression</h1><pre data-results>{results}</pre>
    <h2>Editor reference / four player crops</h2>
    <div data-editor className="media-workspace" style={{ position: 'relative', width: 800, height: 480, background: '#000' }}>
      <div className="canvas-layer selected-layer" style={{ left: 150, top: 50, width: 650, height: 400 }}><EditorMedia layer={layer} onSize={() => {}} /></div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '400px 400px', marginTop: 20 }}>
      {devices.map(d => <div data-pi={d.id} key={d.id} style={{ width: 400, height: 240 }}><ScenePreview scene={scene} devices={devices} deviceId={d.id} player embedded /></div>)}
    </div>
    <h2>Mixed 150×85 mm Pi / 600×337.5 mm TV (10 mm gap)</h2>
    {mixed.map(d => <div data-mixed={d.id} key={d.id} style={{ width: d.width!, height: d.height!, marginTop: 10 }}><ScenePreview scene={mixedScene} devices={mixed} deviceId={d.id} player embedded /></div>)}
    <div data-excluded style={{ width: 400, height: 240 }}><ScenePreview scene={{ ...scene, device_ids: ['tr'] }} devices={devices} deviceId="tl" player embedded /></div>
    {/* Geometry-only video elements: decoding and playback need separate device tests. */}
    {[false, true].map(raw => <div data-video key={String(raw)} style={{ width: 400, height: 240 }}><ScenePreview scene={{ ...scene, layers: [{ ...layer, type: 'video', content: { url: 'data:video/webm;base64,' } }] }} devices={devices} deviceId="br" player embedded rawVideos={raw} /></div>)}
    <details className="screen-list-item" style={{ width: 300 }}><summary><input aria-label="Use tl in this scene" type="checkbox" defaultChecked onClick={event => event.stopPropagation()} /><span>tl</span></summary><div className="screen-details-body"><ScreenLayoutControls device={screen} onChange={change => setScreen({ ...screen, ...change })} /></div></details>
    <output>{JSON.stringify({ width: screen.layout_width, height: screen.layout_height, auto: screen.auto_size })}</output>
  </main>
}
const root = createRoot(document.getElementById('root')!)
root.render(<Fixture />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
