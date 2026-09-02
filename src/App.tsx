import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react'
import { isConfigured, supabase } from './lib/supabase'
import type { Device, Scene, SceneLayer, Wall } from './types'

const starterScene: Scene = {
  id: 'preview', name: 'Welcome', duration_seconds: 60,
  layers: [
    { id: 'welcome', type: 'text', target: [], x: 8, y: 12, width: 84, height: 40, zIndex: 1, content: { text: 'Videowall is ready' } },
    { id: 'clock', type: 'clock', target: [], x: 8, y: 60, width: 45, height: 24, zIndex: 2, content: { timezone: 'Europe/Amsterdam' } },
  ],
}

function App() {
  const player = new URLSearchParams(location.search).get('player') === '1'
  const editorSceneId = new URLSearchParams(location.search).get('editor')
  return player ? <Player /> : <AdminGate editorSceneId={editorSceneId} />
}

function AdminGate({ editorSceneId }: { editorSceneId: string | null }) {
  const [ready, setReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    if (!supabase) { setReady(true); return }
    void supabase.auth.getSession().then(({ data }) => { setSignedIn(Boolean(data.session)); setReady(true) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setSignedIn(Boolean(session)))
    return () => listener.subscription.unsubscribe()
  }, [])
  if (!isConfigured) return <Admin />
  if (!ready) return <main className="player-message">Loading Videowall…</main>
  return signedIn ? (editorSceneId ? <SceneEditorPage sceneId={editorSceneId} /> : <Admin />) : <SignIn />
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  async function signIn(event: FormEvent) {
    event.preventDefault(); if (!supabase) return
    setMessage('Signing in…')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setMessage(error ? error.message : 'Signed in.')
  }
  return <main className="pairing"><form onSubmit={signIn}><p className="eyebrow">PERSONAL DISPLAY CONTROL</p><h1>Videowall</h1><p>Sign in with your private administrator account.</p><input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required /><input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button>Sign in</button><small>{message}</small></form></main>
}

function Admin() {
  const [walls, setWalls] = useState<Wall[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [scenes, setScenes] = useState<Scene[]>([])
  const [activeWall, setActiveWall] = useState<string>('')
  const [selectedSceneId, setSelectedSceneId] = useState<string>('')
  const [pin, setPin] = useState<string>('')
  const [notice, setNotice] = useState('')

  const activeScene = scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0] ?? starterScene
  const selectedWall = walls.find((wall) => wall.id === activeWall)

  useEffect(() => {
    if (!supabase) return
    void (async () => {
      const [{ data: wallData }, { data: sceneData }] = await Promise.all([
        supabase.from('walls').select('id,name').order('created_at'),
        supabase.from('scenes').select('id,name,layers,duration_seconds,device_ids').order('created_at'),
      ])
      setWalls(wallData ?? [])
      setScenes((sceneData ?? []).map((scene) => ({ ...scene, layers: scene.layers as SceneLayer[] })))
      if (sceneData?.[0]) setSelectedSceneId(sceneData[0].id)
      if (wallData?.[0]) setActiveWall(wallData[0].id)
    })()
  }, [])

  useEffect(() => {
    if (!supabase || !activeWall) return
    void supabase.from('devices').select('id,name,wall_id,last_seen_at,width,height').eq('wall_id', activeWall).order('created_at')
      .then(({ data }) => setDevices(data ?? []))
  }, [activeWall])

  async function createWall() {
    const name = prompt('Wall name', 'Living room wall')?.trim()
    if (!name || !supabase) return
    const { data, error } = await supabase.from('walls').insert({ name }).select('id,name').single()
    if (error) return setNotice(error.message)
    setWalls((existing) => [...existing, data]); setActiveWall(data.id)
  }

  async function createPin() {
    if (!supabase || !activeWall) return
    const { data, error } = await supabase.rpc('create_pairing_pin', { requested_wall_id: activeWall })
    if (error) return setNotice(error.message)
    setPin(data as string); setNotice('PIN is valid for 10 minutes.')
  }

  async function publish(scene: Scene) {
    if (!supabase || !activeWall || scene.id === 'preview') return setNotice('Create and save a scene first.')
    const { error } = await supabase.from('wall_state').upsert({ wall_id: activeWall, active_scene_id: scene.id, playback_mode: 'manual', changed_at: new Date().toISOString() })
    setNotice(error ? error.message : `${scene.name} is live.`)
  }

  async function createScene() {
    if (!supabase) return
    const name = prompt('Scene name', 'New scene')?.trim()
    if (!name) return
    const { data, error } = await supabase.from('scenes').insert({ name, layers: starterScene.layers, duration_seconds: 60, device_ids: [] }).select('id,name,layers,duration_seconds,device_ids').single()
    if (error) return setNotice(error.message)
    const newScene = { ...data, layers: data.layers as SceneLayer[] }
    setScenes((existing) => [...existing, newScene]); setSelectedSceneId(newScene.id)
  }

  function updateScene(next: Scene) {
    setScenes((existing) => existing.map((scene) => scene.id === next.id ? next : scene))
  }

  async function saveScene(scene: Scene) {
    if (!supabase || scene.id === 'preview') return
    const { error } = await supabase.from('scenes').update({ name: scene.name, layers: scene.layers, duration_seconds: scene.duration_seconds, device_ids: scene.device_ids ?? [] }).eq('id', scene.id)
    setNotice(error ? error.message : `${scene.name} saved.`)
  }

  return <main className="admin-shell">
    <header><div><p className="eyebrow">PERSONAL DISPLAY CONTROL</p><h1>Videowall</h1></div><a href="?player=1" target="_blank" rel="noreferrer">Open player ↗</a></header>
    {!isConfigured && <div className="alert">Add your Supabase values to <code>.env</code> using <code>.env.example</code>, then apply the migration in <code>supabase/migrations</code>.</div>}
    <section className="toolbar">
      <label>Wall <select value={activeWall} onChange={(event) => setActiveWall(event.target.value)}><option value="">Select a wall</option>{walls.map((wall) => <option key={wall.id} value={wall.id}>{wall.name}</option>)}</select></label>
      <button className="secondary" onClick={() => void createWall()}>+ Wall</button>
      <button disabled={!activeWall} onClick={() => void createPin()}>Pair screen</button>
      {pin && <div className="pin">PIN <strong>{pin}</strong><small>Open {location.origin}/?player=1</small></div>}
    </section>
    {notice && <p className="notice">{notice}</p>}
    <section className="dashboard-grid">
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">{selectedWall?.name ?? 'NO WALL'}</p><h2>Layout</h2></div><span>{devices.length} screens</span></div>
        <div className="wall-preview">{devices.length ? devices.map((device, index) => <div className="screen-card" key={device.id}><span>{index + 1}</span><strong>{device.name}</strong><small>{device.last_seen_at ? 'Online recently' : 'Waiting'}</small></div>) : <p>Pair a Pi to start building your wall.</p>}</div>
      </article>
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">SCENE PREVIEW</p><h2>{activeScene.name}</h2></div><button disabled={!activeWall} onClick={() => void publish(activeScene)}>Publish</button></div><ScenePreview scene={activeScene} /></article>
      <article className="panel scenes"><div className="panel-heading"><h2>Scenes</h2><button className="secondary" onClick={() => void createScene()}>+ Scene</button></div>
        {scenes.length ? scenes.map((scene) => <div className={`scene-row ${scene.id === activeScene.id ? 'selected' : ''}`} key={scene.id}><button className="scene-select" onClick={() => setSelectedSceneId(scene.id)}>{scene.name}</button><small>{scene.layers.length} layers · {scene.duration_seconds}s</small><a className="edit-link" href={`?editor=${scene.id}`}>Edit</a><button onClick={() => void publish(scene)}>Go live</button></div>) : <p>Create your first reusable scene.</p>}
      </article>
    </section>
  </main>
}

function SceneEditor({ scene, onChange, onSave }: { scene: Scene; onChange: (scene: Scene) => void; onSave: () => void }) {
  function changeLayer(index: number, change: Partial<SceneLayer>) {
    const layers = scene.layers.map((layer, current) => current === index ? { ...layer, ...change } : layer)
    onChange({ ...scene, layers })
  }
  function content(index: number, key: 'text' | 'url' | 'timezone', value: string) {
    const layer = scene.layers[index]
    changeLayer(index, { content: { ...layer.content, [key]: value } })
  }
  function addLayer(type: SceneLayer['type']) {
    const layer: SceneLayer = { id: crypto.randomUUID(), type, target: [], x: 10, y: 10, width: 80, height: 24, zIndex: scene.layers.length + 1, content: type === 'clock' ? { timezone: 'Europe/Amsterdam' } : type === 'text' ? { text: 'New text' } : { url: '' } }
    onChange({ ...scene, layers: [...scene.layers, layer] })
  }
  function removeLayer(index: number) { onChange({ ...scene, layers: scene.layers.filter((_layer, current) => current !== index) }) }
  return <article className="panel scene-editor"><div className="panel-heading"><div><p className="eyebrow">EDITING SCENE</p><h2>Layers</h2></div><button onClick={onSave}>Save scene</button></div>
    <div className="scene-basics"><label>Name<input value={scene.name} onChange={(event) => onChange({ ...scene, name: event.target.value })} /></label><label>Cycle duration (seconds)<input type="number" min="1" value={scene.duration_seconds} onChange={(event) => onChange({ ...scene, duration_seconds: Math.max(1, Number(event.target.value)) })} /></label></div>
    <div className="add-layer"><span>Add a layer</span><button className="secondary" onClick={() => addLayer('text')}>Text</button><button className="secondary" onClick={() => addLayer('clock')}>Clock</button><button className="secondary" onClick={() => addLayer('image')}>Image URL</button><button className="secondary" onClick={() => addLayer('video')}>Video URL</button></div>
    {scene.layers.map((layer, index) => <div className="layer-editor" key={layer.id}><select value={layer.type} onChange={(event) => changeLayer(index, { type: event.target.value as SceneLayer['type'] })}><option value="text">Text</option><option value="clock">Clock</option><option value="image">Image</option><option value="video">Video</option></select>
      {layer.type === 'text' && <label>Text<input value={layer.content.text ?? ''} onChange={(event) => content(index, 'text', event.target.value)} /></label>}
      {(layer.type === 'image' || layer.type === 'video') && <label>Media URL<input type="url" placeholder="https://…" value={layer.content.url ?? ''} onChange={(event) => content(index, 'url', event.target.value)} /></label>}
      {layer.type === 'clock' && <label>Timezone<input value={layer.content.timezone ?? ''} onChange={(event) => content(index, 'timezone', event.target.value)} /></label>}
      <label>X %<input type="number" value={layer.x} onChange={(event) => changeLayer(index, { x: Number(event.target.value) })} /></label><label>Y %<input type="number" value={layer.y} onChange={(event) => changeLayer(index, { y: Number(event.target.value) })} /></label><label>Width %<input type="number" value={layer.width} onChange={(event) => changeLayer(index, { width: Number(event.target.value) })} /></label><label>Height %<input type="number" value={layer.height} onChange={(event) => changeLayer(index, { height: Number(event.target.value) })} /></label><button className="danger" onClick={() => removeLayer(index)}>Remove</button>
    </div>)}
  </article>
}

function SceneEditorPage({ sceneId }: { sceneId: string }) {
  const [scene, setScene] = useState<Scene | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [drag, setDrag] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const [deviceDrag, setDeviceDrag] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const [layoutDirty, setLayoutDirty] = useState(false)

  useEffect(() => {
    if (!supabase) return
    void supabase.from('scenes').select('id,name,layers,duration_seconds,device_ids').eq('id', sceneId).single().then(({ data, error }) => {
      if (error) return setNotice(error.message)
      const loaded = { ...data, layers: data.layers as SceneLayer[] }
      setScene(loaded); setSelectedId(loaded.layers[0]?.id ?? '')
    })
  }, [sceneId])
  useEffect(() => { if (supabase) void supabase.from('devices').select('id,name,wall_id,last_seen_at,width,height,layout_x,layout_y,layout_width,layout_height').order('layout_y').order('layout_x').then(({ data }) => setDevices(data ?? [])) }, [])

  if (!scene) return <main className="player-message">{notice || 'Loading scene editor…'}</main>
  const currentScene = scene
  const minX = Math.min(0, ...devices.map((item) => item.layout_x ?? 0))
  const minY = Math.min(0, ...devices.map((item) => item.layout_y ?? 0))
  const maxX = Math.max(1, ...devices.map((item) => (item.layout_x ?? 0) + (item.layout_width ?? 1)))
  const maxY = Math.max(1, ...devices.map((item) => (item.layout_y ?? 0) + (item.layout_height ?? 1)))
  const wallWidth = maxX - minX
  const wallHeight = maxY - minY
  const selected = currentScene.layers.find((layer) => layer.id === selectedId) ?? null
  const isSceneDevice = (deviceId: string) => !currentScene.device_ids?.length || currentScene.device_ids.includes(deviceId)
  function updateLayer(id: string, change: Partial<SceneLayer>) { setScene({ ...currentScene, layers: currentScene.layers.map((layer) => layer.id === id ? { ...layer, ...change } : layer) }) }
  function updateContent(key: 'text' | 'url' | 'timezone' | 'fontFamily', value: string) { if (selected) updateLayer(selected.id, { content: { ...selected.content, [key]: value } }) }
  function updateFontSize(value: number) { if (selected) updateLayer(selected.id, { content: { ...selected.content, fontSize: Math.max(8, value) } }) }
  function addLayer(type: SceneLayer['type']) {
    const layer: SceneLayer = { id: crypto.randomUUID(), type, target: [], x: 10, y: 10, width: type === 'ticker' ? 80 : 45, height: type === 'video' || type === 'image' ? 55 : 20, zIndex: currentScene.layers.length + 1, content: type === 'clock' ? { timezone: 'Europe/Amsterdam' } : type === 'ticker' ? { text: 'Your news ticker goes here' } : type === 'text' ? { text: 'New text' } : { url: '' } }
    setScene({ ...currentScene, layers: [...currentScene.layers, layer] }); setSelectedId(layer.id)
  }
  function removeSelected() { if (!selected) return; setScene({ ...currentScene, layers: currentScene.layers.filter((layer) => layer.id !== selected.id) }); setSelectedId('') }
  function moveLayer(direction: 'up' | 'down') { if (!selected) return; const next = Math.max(1, selected.zIndex + (direction === 'up' ? 1 : -1)); updateLayer(selected.id, { zIndex: next }) }
  function toggleTarget(deviceId: string) { if (!selected) return; const target = !selected.target.length ? devices.filter((item) => item.id !== deviceId).map((item) => item.id) : selected.target.includes(deviceId) ? selected.target.filter((id) => id !== deviceId) : [...selected.target, deviceId]; updateLayer(selected.id, { target }) }
  function toggleSceneDevice(deviceId: string) {
    const current = currentScene.device_ids ?? []
    const next = !current.length ? devices.filter((item) => item.id !== deviceId).map((item) => item.id) : current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId]
    setScene({ ...currentScene, device_ids: next.length === devices.length ? [] : next })
  }
  function updateDeviceLayout(deviceId: string, change: Partial<Device>) {
    setDevices((items) => items.map((item) => item.id === deviceId ? { ...item, ...change } : item)); setLayoutDirty(true)
  }
  async function save() {
    if (!supabase) return
    const { error } = await supabase.from('scenes').update({ name: currentScene.name, layers: currentScene.layers, duration_seconds: currentScene.duration_seconds, device_ids: currentScene.device_ids ?? [] }).eq('id', currentScene.id)
    setNotice(error ? error.message : 'Scene saved. Publish it from the dashboard when ready.')
  }
  async function saveLayout() {
    if (!supabase) return
    const client = supabase
    const results = await Promise.all(devices.map(({ id, layout_x, layout_y, layout_width, layout_height }) => client.from('devices').update({ layout_x, layout_y, layout_width, layout_height }).eq('id', id)))
    const error = results.find((result) => result.error)?.error
    if (error) return setNotice(error.message)
    setLayoutDirty(false); setNotice('Physical screen layout saved.')
  }
  async function upload(file: File) {
    if (!supabase || !selected) return
    setNotice('Uploading media…')
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80)
    const path = `${currentScene.id}/${crypto.randomUUID()}-${safeName}`
    const { error } = await supabase.storage.from('media').upload(path, file, { cacheControl: '31536000', upsert: false })
    if (error) return setNotice(error.message)
    const { data } = supabase.storage.from('media').getPublicUrl(path)
    updateLayer(selected.id, { content: { ...selected.content, url: data.publicUrl } }); setNotice('Uploaded. Save the scene to keep this layer.')
  }
  function startDrag(event: PointerEvent<HTMLDivElement>, layer: SceneLayer) {
    const box = event.currentTarget.parentElement!.getBoundingClientRect()
    setSelectedId(layer.id); setDrag({ id: layer.id, offsetX: ((event.clientX - box.left) / box.width) * 100 - layer.x, offsetY: ((event.clientY - box.top) / box.height) * 100 - layer.y })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function dragLayer(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return
    const box = event.currentTarget.getBoundingClientRect(); const layer = currentScene.layers.find((item) => item.id === drag.id); if (!layer) return
    const x = Math.max(0, Math.min(100 - layer.width, ((event.clientX - box.left) / box.width) * 100 - drag.offsetX)); const y = Math.max(0, Math.min(100 - layer.height, ((event.clientY - box.top) / box.height) * 100 - drag.offsetY))
    updateLayer(drag.id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })
  }
  function startDeviceDrag(event: PointerEvent<HTMLSpanElement>, device: Device) {
    const box = event.currentTarget.parentElement!.parentElement!.getBoundingClientRect()
    setDeviceDrag({ id: device.id, offsetX: ((event.clientX - box.left) / box.width) * wallWidth + minX - (device.layout_x ?? 0), offsetY: ((event.clientY - box.top) / box.height) * wallHeight + minY - (device.layout_y ?? 0) })
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation()
  }
  function dragDevice(event: PointerEvent<HTMLDivElement>) {
    if (!deviceDrag) return
    const box = event.currentTarget.getBoundingClientRect()
    const x = Math.round(((event.clientX - box.left) / box.width) * wallWidth + minX - deviceDrag.offsetX)
    const y = Math.round(((event.clientY - box.top) / box.height) * wallHeight + minY - deviceDrag.offsetY)
    updateDeviceLayout(deviceDrag.id, { layout_x: x, layout_y: y })
  }
  return <main className="editor-page">
    <header className="editor-header"><a href="/">← Dashboard</a><div><input aria-label="Scene name" value={currentScene.name} onChange={(event) => setScene({ ...currentScene, name: event.target.value })} /><p>Scene editor</p></div><div className="editor-actions"><button className="secondary" disabled={!layoutDirty} onClick={() => void saveLayout()}>Save screen layout</button><button onClick={() => void save()}>Save scene</button></div></header>
    <div className="editor-layout"><aside className="editor-toolbar"><p className="eyebrow">ADD TO SCENE</p><button onClick={() => addLayer('text')}>T Text</button><button onClick={() => addLayer('clock')}>◷ Clock</button><button onClick={() => addLayer('ticker')}>↔ Ticker</button><button onClick={() => addLayer('image')}>▣ Image</button><button onClick={() => addLayer('video')}>▶ Video</button><div className="screen-list"><p className="eyebrow">SCREENS IN THIS SCENE</p>{devices.map((item) => <div className="screen-list-item" key={item.id}><label><input type="checkbox" checked={isSceneDevice(item.id)} onChange={() => toggleSceneDevice(item.id)} /> <span>{item.name}</span></label><div><label>W<input type="number" min="1" value={item.layout_width ?? 16} onChange={(event) => updateDeviceLayout(item.id, { layout_width: Math.max(1, Number(event.target.value)) })} /></label><label>H<input type="number" min="1" value={item.layout_height ?? 9} onChange={(event) => updateDeviceLayout(item.id, { layout_height: Math.max(1, Number(event.target.value)) })} /></label></div></div>)}</div><small>Drag a screen label in the layout to match the real wall. Use the list to remove a screen from this scene only.</small></aside>
      <section className="editor-stage-wrap"><div className="editor-stage" style={{ aspectRatio: `${wallWidth} / ${wallHeight}` }} onPointerMove={(event) => { dragLayer(event); dragDevice(event) }} onPointerUp={() => { setDrag(null); setDeviceDrag(null) }} onPointerCancel={() => { setDrag(null); setDeviceDrag(null) }}>{devices.map((item) => <div className={`device-mask ${isSceneDevice(item.id) ? '' : 'inactive-device'}`} key={item.id} style={{ left: `${(((item.layout_x ?? 0) - minX) / wallWidth) * 100}%`, top: `${(((item.layout_y ?? 0) - minY) / wallHeight) * 100}%`, width: `${((item.layout_width ?? 1) / wallWidth) * 100}%`, height: `${((item.layout_height ?? 1) / wallHeight) * 100}%` }}><span onPointerDown={(event) => startDeviceDrag(event, item)}>{item.name}</span></div>)}{currentScene.layers.map((layer) => { const typography = { fontFamily: layer.content.fontFamily ?? "'Roboto', sans-serif", fontSize: layer.content.fontSize ? `${layer.content.fontSize / 19.2}cqw` : undefined }; return <div key={layer.id} className={`canvas-layer ${layer.id === selectedId ? 'selected-layer' : ''}`} style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, zIndex: layer.zIndex }} onPointerDown={(event) => startDrag(event, layer)}>{layer.type === 'image' && layer.content.url ? <img src={layer.content.url} alt="" /> : layer.type === 'video' && layer.content.url ? <video className="editor-video" src={layer.content.url} autoPlay muted loop playsInline /> : layer.type === 'video' ? <div className="media-placeholder">▶ Video source</div> : layer.type === 'clock' ? <Clock style={{}} timezone={layer.content.timezone} /> : layer.type === 'ticker' ? <div className="ticker-preview" style={typography}>{layer.content.text}</div> : <div className="text-preview" style={typography}>{layer.content.text}</div>}</div> })}</div><p className="canvas-hint">Each outline is a physical display. Drag its label to arrange it; dimmed screens are excluded from this scene.</p></section>
      <aside className="inspector"><p className="eyebrow">{selected ? 'SELECTED LAYER' : 'INSPECTOR'}</p>{selected ? <><label>Type<select value={selected.type} onChange={(event) => updateLayer(selected.id, { type: event.target.value as SceneLayer['type'] })}><option value="text">Text</option><option value="clock">Clock</option><option value="ticker">Ticker</option><option value="image">Image</option><option value="video">Video</option></select></label>{(selected.type === 'text' || selected.type === 'ticker') && <><label>Content<textarea value={selected.content.text ?? ''} onChange={(event) => updateContent('text', event.target.value)} /></label><label>Font<select value={selected.content.fontFamily ?? "'Roboto', sans-serif"} onChange={(event) => updateContent('fontFamily', event.target.value)}><option value="'Roboto', sans-serif">Roboto</option><option value="'Space Grotesk', sans-serif">Space Grotesk</option><option value="'Source Serif 4', serif">Source Serif 4</option><option value="'JetBrains Mono', monospace">JetBrains Mono</option></select></label><label>Font size at 1920px (px)<input type="number" min="8" max="240" value={selected.content.fontSize ?? 56} onChange={(event) => updateFontSize(Number(event.target.value))} /></label></>}{selected.type === 'clock' && <label>Timezone<input value={selected.content.timezone ?? ''} onChange={(event) => updateContent('timezone', event.target.value)} /></label>}{(selected.type === 'image' || selected.type === 'video') && <><label>Media URL<input type="url" value={selected.content.url ?? ''} onChange={(event) => updateContent('url', event.target.value)} placeholder="https://…" /></label><label className="upload-button">Upload {selected.type}<input type="file" accept={selected.type === 'video' ? 'video/*' : 'image/*'} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file) }} /></label></>}<div className="stack-controls"><button className="secondary" onClick={() => moveLayer('up')}>Bring forward</button><button className="secondary" onClick={() => moveLayer('down')}>Send backward</button></div><div className="position-grid">{(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key}>{key}<input type="number" min="0" max="100" value={selected[key]} onChange={(event) => updateLayer(selected.id, { [key]: Number(event.target.value) })} /></label>)}</div><button className="danger" onClick={removeSelected}>Remove layer</button></> : <p>Select an item on the canvas to edit it.</p>}</aside>
    </div>{selected && <section className="wall-layer-controls"><label>Layer canvas<select value={selected.space ?? 'screen'} onChange={(event) => updateLayer(selected.id, { space: event.target.value as 'screen' | 'wall' })}><option value="screen">Each display</option><option value="wall">Full wall — span and crop across displays</option></select></label>{selected.space === 'wall' && <div className="target-picker"><span>Displays used by this wall layer</span>{devices.map((item) => <label key={item.id}><input type="checkbox" checked={!selected.target.length || selected.target.includes(item.id)} onChange={() => toggleTarget(item.id)} /> {item.name}</label>)}</div>}</section>}{notice && <p className="editor-notice">{notice}</p>}
  </main>
}

function Player() {
  const [pin, setPin] = useState('')
  const [device, setDevice] = useState<{ id: string; token: string } | null>(() => { try { return JSON.parse(localStorage.getItem('videowall-device') ?? 'null') } catch { return null } })
  const [scene, setScene] = useState<Scene | null>(null)
  const [status, setStatus] = useState('Enter the PIN shown in the admin dashboard.')
  const [serverOffsetMs, setServerOffsetMs] = useState(0)
  const [wallDevices, setWallDevices] = useState<Device[]>([])
  const [sceneStartedAtMs, setSceneStartedAtMs] = useState(0)

  useEffect(() => {
    const refresh = window.setTimeout(() => location.reload(), 6 * 60 * 60 * 1000)
    return () => window.clearTimeout(refresh)
  }, [])

  useEffect(() => {
    if (!device || !supabase) return
    const client = supabase
    const refresh = async () => {
      const startedAt = Date.now()
      const { data, error } = await client.rpc('get_player_state', { requested_device_id: device.id, requested_token: device.token })
      const receivedAt = Date.now()
      if (error) return setStatus('Connection issue — retrying…')
      if (data?.scene) setScene({ ...data.scene, layers: data.scene.layers as SceneLayer[] })
      if (data?.devices) setWallDevices(data.devices as Device[])
      if (data?.server_now) setServerOffsetMs(new Date(data.server_now).getTime() - (startedAt + receivedAt) / 2)
      if (data?.scene_started_at) setSceneStartedAtMs(new Date(data.scene_started_at).getTime())
      setStatus('Connected')
      await client.rpc('player_heartbeat', { requested_device_id: device.id, requested_token: device.token, viewport_width: innerWidth, viewport_height: innerHeight })
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(timer)
  }, [device])

  async function pair(event: FormEvent) {
    event.preventDefault(); if (!supabase || !pin.trim()) return
    setStatus('Pairing…')
    const { data, error } = await supabase.rpc('claim_pairing_pin', { pin_value: pin.trim(), device_name: `Pi display ${new Date().toLocaleTimeString()}`, viewport_width: innerWidth, viewport_height: innerHeight })
    if (error) return setStatus(error.message)
    const claimed = data as { id: string; token: string }
    localStorage.setItem('videowall-device', JSON.stringify(claimed)); setDevice(claimed)
  }

  if (!isConfigured) return <main className="player-message">This player needs Supabase configuration.</main>
  if (!device) return <main className="pairing"><form onSubmit={pair}><p className="eyebrow">VIDEOWALL PLAYER</p><h1>Pair this screen</h1><p>Enter the one-time PIN from the dashboard.</p><input autoFocus inputMode="numeric" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} placeholder="000000" /><button>Connect display</button><small>{status}</small></form></main>
  return scene ? <ScenePreview scene={scene} player deviceId={device.id} devices={wallDevices} serverOffsetMs={serverOffsetMs} sceneStartedAtMs={sceneStartedAtMs} /> : <main className="player-message">{status}</main>
}

function ScenePreview({ scene, player = false, deviceId, devices = [], serverOffsetMs = 0, sceneStartedAtMs = 0 }: { scene: Scene; player?: boolean; deviceId?: string; devices?: Device[]; serverOffsetMs?: number; sceneStartedAtMs?: number }) {
  const targetId = useMemo(() => player ? 'player' : 'preview', [player])
  const current = devices.find((item) => item.id === deviceId)
  const minX = Math.min(0, ...devices.map((item) => item.layout_x ?? 0))
  const minY = Math.min(0, ...devices.map((item) => item.layout_y ?? 0))
  const totalWidth = Math.max(1, ...devices.map((item) => (item.layout_x ?? 0) + (item.layout_width ?? 1))) - minX
  const totalHeight = Math.max(1, ...devices.map((item) => (item.layout_y ?? 0) + (item.layout_height ?? 1))) - minY
  if (player && deviceId && scene.device_ids?.length && !scene.device_ids.includes(deviceId)) return <div id={targetId} className="player-canvas" />
  const layers = deviceId ? scene.layers.filter((layer) => !layer.target.length || layer.target.includes(deviceId)) : scene.layers
  return <div id={targetId} className={player ? 'player-canvas' : 'scene-preview'}>{layers.map((layer) => {
    if (player && layer.space === 'wall' && current) {
      const left = ((layer.x - (((current.layout_x ?? 0) - minX) / totalWidth) * 100) / ((current.layout_width ?? 1) / totalWidth))
      const top = ((layer.y - (((current.layout_y ?? 0) - minY) / totalHeight) * 100) / ((current.layout_height ?? 1) / totalHeight))
      const width = layer.width / ((current.layout_width ?? 1) / totalWidth)
      const height = layer.height / ((current.layout_height ?? 1) / totalHeight)
      return <Layer key={layer.id} layer={layer} serverOffsetMs={serverOffsetMs} sceneStartedAtMs={sceneStartedAtMs} styleOverride={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }} />
    }
    return <Layer key={layer.id} layer={layer} serverOffsetMs={serverOffsetMs} sceneStartedAtMs={sceneStartedAtMs} />
  })}</div>
}

function Layer({ layer, styleOverride, serverOffsetMs = 0, sceneStartedAtMs = 0 }: { layer: SceneLayer; styleOverride?: CSSProperties; serverOffsetMs?: number; sceneStartedAtMs?: number }) {
  const style = { left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, zIndex: layer.zIndex, opacity: layer.opacity ?? 1, ...styleOverride }
  const typography = { fontFamily: layer.content.fontFamily ?? "'Roboto', sans-serif", fontSize: layer.content.fontSize ? `${layer.content.fontSize / 19.2}cqw` : undefined }
  if (layer.type === 'video' && layer.content.url) return <SyncedVideo style={style} src={layer.content.url} muted={layer.content.muted !== false} loop={layer.content.loop !== false} serverOffsetMs={serverOffsetMs} sceneStartedAtMs={sceneStartedAtMs} />
  if (layer.type === 'image' && layer.content.url) return <img className="media-layer" style={style} src={layer.content.url} alt="" />
  if (layer.type === 'clock') return <Clock style={style} timezone={layer.content.timezone} serverOffsetMs={serverOffsetMs} />
  if (layer.type === 'ticker') return <div className="ticker-layer" style={{ ...style, ...typography }}><span>{layer.content.text}</span></div>
  return <div className="text-layer" style={{ ...style, ...typography }}>{layer.content.text}</div>
}

function SyncedVideo({ style, src, muted, loop, serverOffsetMs, sceneStartedAtMs }: { style: CSSProperties; src: string; muted: boolean; loop: boolean; serverOffsetMs: number; sceneStartedAtMs: number }) {
  const videoRef = useState(() => ({ current: null as HTMLVideoElement | null }))[0]
  useEffect(() => {
    const video = videoRef.current; if (!video || !sceneStartedAtMs) return
    const align = () => { if (video.duration && Number.isFinite(video.duration)) video.currentTime = ((Date.now() + serverOffsetMs - sceneStartedAtMs) / 1000) % video.duration }
    video.addEventListener('loadedmetadata', align); align(); void video.play().catch(() => undefined)
    return () => video.removeEventListener('loadedmetadata', align)
  }, [src, serverOffsetMs, sceneStartedAtMs, videoRef])
  return <video className="media-layer" ref={(node) => { videoRef.current = node }} style={style} src={src} autoPlay muted={muted} loop={loop} playsInline />
}

function Clock({ style, timezone, serverOffsetMs = 0 }: { style: CSSProperties; timezone?: string; serverOffsetMs?: number }) {
  const [now, setNow] = useState(new Date()); useEffect(() => { const timer = setInterval(() => setNow(new Date()), 250); return () => clearInterval(timer) }, [])
  return <time className="clock-layer" style={style}>{new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: timezone }).format(new Date(now.getTime() + serverOffsetMs))}</time>
}

export default App
