import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type WheelEvent } from 'react'
import { isConfigured, supabase } from './lib/supabase'
import type { Device, Scene, SceneLayer, Wall } from './types'
import { WALL_WORKSPACE_WIDTH, WALL_WORKSPACE_HEIGHT, WORKSPACE, bounds, deviceRect, sceneDevices, layerReference, toWorkspaceLayer, planeTransform, fitLayerToDevices } from './lib/wallGeometry'
import { panForCursorZoom } from './lib/editorZoom'
import { ScreenLayoutControls } from './ScreenLayoutControls'

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
    void supabase.from('devices').select('id,name,wall_id,last_seen_at,width,height,layout_x,layout_y,layout_width,layout_height,auto_size').eq('wall_id', activeWall).order('created_at')
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

  async function deleteWall() {
    if (!supabase || !activeWall || !selectedWall) return
    if (!confirm(`Delete wall “${selectedWall.name}” and every paired screen on it? This cannot be undone.`)) return
    const { error } = await supabase.from('walls').delete().eq('id', activeWall)
    if (error) return setNotice(error.message)
    const remaining = walls.filter((wall) => wall.id !== activeWall)
    setWalls(remaining); setActiveWall(remaining[0]?.id ?? ''); setDevices([]); setNotice('Wall and its paired screens were deleted.')
  }

  async function deleteDevice(device: Device) {
    if (!supabase) return
    if (!confirm(`Remove paired screen “${device.name}”? The Pi can be paired again later with a new PIN.`)) return
    const { error } = await supabase.from('devices').delete().eq('id', device.id)
    if (error) return setNotice(error.message)
    setDevices((current) => current.filter((item) => item.id !== device.id)); setNotice(`${device.name} was removed. It can no longer play this wall until paired again.`)
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

  async function deleteScene(scene: Scene) {
    if (!supabase || scene.id === 'preview') return
    if (!confirm(`Delete scene “${scene.name}”? This cannot be undone.`)) return
    const { error } = await supabase.from('scenes').delete().eq('id', scene.id)
    if (error) return setNotice(error.message)
    const remaining = scenes.filter((item) => item.id !== scene.id)
    setScenes(remaining); setSelectedSceneId(remaining[0]?.id ?? ''); setNotice('Scene deleted.')
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
      <button className="danger" disabled={!activeWall} onClick={() => void deleteWall()}>Delete wall</button>
      <button disabled={!activeWall} onClick={() => void createPin()}>Pair screen</button>
      {pin && <div className="pin">PIN <strong>{pin}</strong><small>Open {location.origin}/?player=1</small></div>}
    </section>
    {notice && <p className="notice">{notice}</p>}
    <section className="dashboard-grid">
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">{selectedWall?.name ?? 'NO WALL'}</p><h2>Layout</h2></div><span>{devices.length} screens</span></div>
        <div className="wall-preview">{devices.length ? devices.map((device, index) => <div className="screen-card" key={device.id}><span>{index + 1}</span><strong>{device.name}</strong><small>{device.last_seen_at ? 'Online recently' : 'Waiting'}</small><button className="danger" onClick={() => void deleteDevice(device)}>Remove Pi</button></div>) : <p>Pair a Pi to start building your wall.</p>}</div>
      </article>
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">SCENE PREVIEW</p><h2>{activeScene.name}</h2></div><button disabled={!activeWall} onClick={() => void publish(activeScene)}>Publish</button></div><ScenePreview scene={activeScene} devices={devices} /></article>
      <article className="panel scenes"><div className="panel-heading"><h2>Scenes</h2><button className="secondary" onClick={() => void createScene()}>+ Scene</button></div>
        {scenes.length ? scenes.map((scene) => <div className={`scene-row ${scene.id === activeScene.id ? 'selected' : ''}`} key={scene.id}><button className="scene-select" onClick={() => setSelectedSceneId(scene.id)}>{scene.name}</button><small>{scene.layers.length} layers · {scene.duration_seconds}s</small><a className="edit-link" href={`?editor=${scene.id}`}>Edit</a><button onClick={() => void publish(scene)}>Go live</button><button className="danger" onClick={() => void deleteScene(scene)}>Delete</button></div>) : <p>Create your first reusable scene.</p>}
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
  const [drag, setDrag] = useState<{ id: string; offsetX: number; offsetY: number; deviceId?: string } | null>(null)
  const [deviceDrag, setDeviceDrag] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const [layoutDirty, setLayoutDirty] = useState(false)
  const [devicesLoaded, setDevicesLoaded] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panDrag, setPanDrag] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)

  useEffect(() => {
    if (!supabase) return
    void supabase.from('scenes').select('id,name,layers,duration_seconds,device_ids').eq('id', sceneId).single().then(({ data, error }) => {
      if (error) return setNotice(error.message)
      const loaded = { ...data, layers: data.layers as SceneLayer[] }
      setScene(loaded); setSelectedId(loaded.layers[0]?.id ?? '')
    })
  }, [sceneId])
  useEffect(() => { if (supabase) void supabase.from('devices').select('id,name,wall_id,last_seen_at,width,height,layout_x,layout_y,layout_width,layout_height,auto_size').order('layout_y').order('layout_x').then(({ data, error }) => {
    if (error) { setNotice(error.message); return }
    setDevices(data ?? []); setDevicesLoaded(true)
  }) }, [])
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => { if (event.code === 'Space' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); setSpaceHeld(true) } }
    const keyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp)
    return () => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp) }
  }, [])
  if (!scene || !devicesLoaded) return <main className="player-message">{notice || 'Loading scene editor…'}</main>
  const currentScene = { ...scene, layers: scene.layers.map(layer => toWorkspaceLayer(layer, scene, devices)) }
  const activeDevices = sceneDevices(currentScene, devices)
  const selected = currentScene.layers.find((layer) => layer.id === selectedId) ?? null
  const isSceneDevice = (deviceId: string) => !currentScene.device_ids?.length || currentScene.device_ids.includes(deviceId)
  function updateLayer(id: string, change: Partial<SceneLayer>) { setScene({ ...currentScene, layers: currentScene.layers.map((layer) => layer.id === id ? { ...layer, ...change } : layer) }) }
  function updateContent(key: 'text' | 'url' | 'timezone' | 'fontFamily', value: string) { if (selected) updateLayer(selected.id, { content: { ...selected.content, [key]: value } }) }
  function updateFontSize(value: number) { if (selected) updateLayer(selected.id, { content: { ...selected.content, fontSize: Math.max(8, value) } }) }
  function addLayer(type: 'image' | 'video') {
    const layer: SceneLayer = { id: crypto.randomUUID(), type, target: [], space: 'wall', coordinateSpace: 'freeform', x: 10, y: 10, width: 45, height: 45, zIndex: currentScene.layers.length + 1, scale: 1, rotation: 0, lockedAspect: true, aspectRatio: 16 / 9, content: { url: '' } }
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
    // Save only explicit geometry for manual layouts; automatic dimensions can
    // have been refreshed by a Pi since the editor opened.
    const results = await Promise.all(devices.map(({ id, name, layout_x, layout_y, layout_width, layout_height, auto_size }) => client.from('devices').update({ name, layout_x, layout_y, auto_size,
      ...(auto_size === false ? { layout_width, layout_height } : {}) }).eq('id', id)))
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
  function startDrag(event: PointerEvent<HTMLDivElement>, layer: SceneLayer, device?: Device) {
    if (spaceHeld) return
    const box = event.currentTarget.closest('.editor-stage')!.getBoundingClientRect()
    const pointX = ((event.clientX - box.left) / box.width) * 100
    const pointY = ((event.clientY - box.top) / box.height) * 100
    const screenLeft = device ? ((device.layout_x ?? 0) / WALL_WORKSPACE_WIDTH) * 100 : 0
    const screenTop = device ? ((device.layout_y ?? 0) / WALL_WORKSPACE_HEIGHT) * 100 : 0
    const screenWidth = device ? ((device.layout_width ?? 1) / WALL_WORKSPACE_WIDTH) * 100 : 100
    const screenHeight = device ? ((device.layout_height ?? 1) / WALL_WORKSPACE_HEIGHT) * 100 : 100
    setSelectedId(layer.id); setDrag({ id: layer.id, deviceId: device?.id, offsetX: (pointX - screenLeft) / screenWidth * 100 - layer.x, offsetY: (pointY - screenTop) / screenHeight * 100 - layer.y })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function dragLayer(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return
    const box = event.currentTarget.getBoundingClientRect(); const layer = currentScene.layers.find((item) => item.id === drag.id); if (!layer) return
    const device = devices.find((item) => item.id === drag.deviceId)
    const pointX = ((event.clientX - box.left) / box.width) * 100
    const pointY = ((event.clientY - box.top) / box.height) * 100
    const screenLeft = device ? ((device.layout_x ?? 0) / WALL_WORKSPACE_WIDTH) * 100 : 0
    const screenTop = device ? ((device.layout_y ?? 0) / WALL_WORKSPACE_HEIGHT) * 100 : 0
    const screenWidth = device ? ((device.layout_width ?? 1) / WALL_WORKSPACE_WIDTH) * 100 : 100
    const screenHeight = device ? ((device.layout_height ?? 1) / WALL_WORKSPACE_HEIGHT) * 100 : 100
    const x = (pointX - screenLeft) / screenWidth * 100 - drag.offsetX; const y = (pointY - screenTop) / screenHeight * 100 - drag.offsetY
    updateLayer(drag.id, { x, y })
  }
  function startDeviceDrag(event: PointerEvent<HTMLSpanElement>, device: Device) {
    if (spaceHeld) return
    const box = event.currentTarget.parentElement!.parentElement!.getBoundingClientRect()
    setDeviceDrag({ id: device.id, offsetX: ((event.clientX - box.left) / box.width) * WALL_WORKSPACE_WIDTH - (device.layout_x ?? 0), offsetY: ((event.clientY - box.top) / box.height) * WALL_WORKSPACE_HEIGHT - (device.layout_y ?? 0) })
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation()
  }
  function dragDevice(event: PointerEvent<HTMLDivElement>) {
    if (!deviceDrag) return
    const box = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * WALL_WORKSPACE_WIDTH - deviceDrag.offsetX
    const y = ((event.clientY - box.top) / box.height) * WALL_WORKSPACE_HEIGHT - deviceDrag.offsetY
    updateDeviceLayout(deviceDrag.id, { layout_x: x, layout_y: y })
  }
  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 1 && !spaceHeld) return
    setPanDrag({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y })
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault()
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    if (!panDrag) return
    setPan({ x: panDrag.panX + event.clientX - panDrag.x, y: panDrag.panY + event.clientY - panDrag.y })
  }
  function zoomCanvas(event: WheelEvent<HTMLElement>) {
    event.preventDefault()
    const nextZoom = Math.max(.2, Math.min(128, Number((zoom * (event.deltaY < 0 ? 1.18 : .85)).toFixed(3))))
    const stage = stageRef.current
    if (stage && nextZoom !== zoom) {
      const box = stage.getBoundingClientRect()
      setPan(current => panForCursorZoom({ pan: current, zoom, nextZoom, stage: box, cursor: { x: event.clientX, y: event.clientY } }))
    }
    setZoom(nextZoom)
  }
  function fitScreens() {
    const stage = stageRef.current
    if (!stage || !activeDevices.length) return
    const box = bounds(activeDevices.map(deviceRect))
    const nextZoom = Math.max(.2, Math.min(128, .8 * Math.min(WALL_WORKSPACE_WIDTH / box.width, WALL_WORKSPACE_HEIGHT / box.height)))
    setZoom(nextZoom)
    setPan({ x: (0.5 - (box.x + box.width / 2) / WALL_WORKSPACE_WIDTH) * stage.clientWidth * nextZoom,
      y: (0.5 - (box.y + box.height / 2) / WALL_WORKSPACE_HEIGHT) * stage.clientHeight * nextZoom })
  }
  function setMediaSize(layerId: string, sourceWidth: number, sourceHeight: number) {
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return
    const layer = currentScene.layers.find((item) => item.id === layerId)
    if (!layer) return
    // Do not overwrite deliberate resize/scale choices after the first media decode.
    if (layer.sourceWidth === sourceWidth && layer.sourceHeight === sourceHeight) return
    const screenSpace = (layer.space ?? 'screen') === 'screen'
    const target = devices.find((item) => isSceneDevice(item.id) && (!layer.target.length || layer.target.includes(item.id)))
    const referenceWidth = screenSpace ? target?.layout_width ?? 1920 : WALL_WORKSPACE_WIDTH
    const referenceHeight = screenSpace ? target?.layout_height ?? 1080 : WALL_WORKSPACE_HEIGHT
    updateLayer(layerId, { sourceWidth, sourceHeight, aspectRatio: sourceWidth / sourceHeight, width: sourceWidth / referenceWidth * 100, height: sourceHeight / referenceHeight * 100 })
  }
  function updateDimension(key: 'width' | 'height', value: number) {
    if (!selected) return
    const change: Partial<SceneLayer> = { [key]: value }
    if (selected.lockedAspect && selected.aspectRatio) {
      const target = activeDevices.find(item => !selected.target.length || selected.target.includes(item.id))
      const reference = layerReference(selected, currentScene, devices, target)
      if (key === 'width') change.height = value * (reference.width / reference.height) / selected.aspectRatio
      else change.width = value * selected.aspectRatio / (reference.width / reference.height)
    }
    updateLayer(selected.id, change)
  }
  function renderEditorMedia(layer: SceneLayer) {
    return <EditorMedia layer={layer} onSize={(width, height) => setMediaSize(layer.id, width, height)} />
  }
  return <main className="editor-page">
    <header className="editor-header"><a href="/">← Dashboard</a><div><input aria-label="Scene name" value={currentScene.name} onChange={(event) => setScene({ ...currentScene, name: event.target.value })} /><p>Scene editor</p></div><div className="editor-actions"><button className="secondary" disabled={!layoutDirty} onClick={() => void saveLayout()}>Save screen layout</button><button onClick={() => void save()}>Save scene</button></div></header>
    <div className="editor-layout"><aside className="editor-toolbar"><div className="screen-list"><p className="eyebrow">SCREENS IN THIS SCENE</p><small>Choose displays, then place their lit image areas. Left/Top include bezels and gaps. Save screen layout to apply changes to the players.</small>{devices.map((item) => <details className="screen-list-item" key={item.id}><summary><input aria-label={`Use ${item.name} in this scene`} type="checkbox" checked={isSceneDevice(item.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSceneDevice(item.id)} /><span>{item.name}</span></summary><div className="screen-details-body"><label>Name<input value={item.name} onChange={(event) => updateDeviceLayout(item.id, { name: event.target.value })} /></label><ScreenLayoutControls device={item} onChange={change => updateDeviceLayout(item.id, change)} /></div></details>)}</div>{activeDevices.some(d => d.auto_size === false) && activeDevices.some(d => d.auto_size !== false) && <p className="notice">Mixed layout units: enter measured sizes for every selected screen before aligning them.</p>}{selected && <section className="wall-layer-controls"><label>Layer canvas<select value={selected.space ?? 'screen'} onChange={(event) => updateLayer(selected.id, { space: event.target.value as 'screen' | 'wall' })}><option value="screen">One copy on each selected display</option><option value="wall">Full wall — span and crop across displays</option></select></label><div className="target-picker"><span>This layer appears on</span>{devices.map((item) => <label key={item.id} className={!isSceneDevice(item.id) ? 'disabled-target' : ''}><input type="checkbox" disabled={!isSceneDevice(item.id)} checked={isSceneDevice(item.id) && (!selected.target.length || selected.target.includes(item.id))} onChange={() => toggleTarget(item.id)} /> {item.name}</label>)}</div></section>}<p className="eyebrow">ADD MEDIA</p><button onClick={() => addLayer('image')}>▣ Image</button><button onClick={() => addLayer('video')}>▶ Video</button><small>Screen outlines stay above media. Drag a screen label to position that display independently.</small></aside>
      <section className="editor-stage-wrap" onWheel={zoomCanvas}><div className="canvas-controls"><button className="secondary" onClick={() => setZoom((current) => Math.max(.2, current - .2))}>−</button><span>{Math.round(zoom * 100)}%</span><button className="secondary" onClick={() => setZoom((current) => Math.min(128, current + .2))}>+</button><button className="secondary" onClick={fitScreens}>Fit screens</button><button className="secondary" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>Reset</button></div><div ref={stageRef} className={`editor-stage media-workspace ${spaceHeld || panDrag ? 'panning-workspace' : ''}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, '--guide-inset': `${(1 - zoom) * 50}%`, '--guide-size': `${zoom * 100}%`, '--guide-scale': 1 / zoom } as CSSProperties} onPointerDown={startPan} onPointerMove={(event) => { movePan(event); dragLayer(event); dragDevice(event) }} onPointerUp={() => { setDrag(null); setDeviceDrag(null); setPanDrag(null) }} onPointerCancel={() => { setDrag(null); setDeviceDrag(null); setPanDrag(null) }}>{currentScene.layers.map((layer) => (layer.space ?? 'screen') === 'screen' ? devices.filter((item) => isSceneDevice(item.id) && (!layer.target.length || layer.target.includes(item.id))).map((item) => <div className="screen-layer-clip" key={`${layer.id}-${item.id}`} style={{ left: `${((item.layout_x ?? 0) / WALL_WORKSPACE_WIDTH) * 100}%`, top: `${((item.layout_y ?? 0) / WALL_WORKSPACE_HEIGHT) * 100}%`, width: `${((item.layout_width ?? 1) / WALL_WORKSPACE_WIDTH) * 100}%`, height: `${((item.layout_height ?? 1) / WALL_WORKSPACE_HEIGHT) * 100}%`, zIndex: layer.zIndex }}><div className={`canvas-layer ${layer.id === selectedId ? 'selected-layer' : ''}`} style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` }} onPointerDown={(event) => startDrag(event, layer, item)}>{renderEditorMedia(layer)}</div></div>) : <div key={layer.id} className={`canvas-layer ${layer.id === selectedId ? 'selected-layer' : ''}`} style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, zIndex: layer.zIndex, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` }} onPointerDown={(event) => startDrag(event, layer)}>{renderEditorMedia(layer)}</div>)}{devices.map((item) => <div className={`device-mask ${isSceneDevice(item.id) ? '' : 'inactive-device'}`} key={item.id} style={{ left: `${((item.layout_x ?? 0) / WALL_WORKSPACE_WIDTH) * 100}%`, top: `${((item.layout_y ?? 0) / WALL_WORKSPACE_HEIGHT) * 100}%`, width: `${((item.layout_width ?? 1) / WALL_WORKSPACE_WIDTH) * 100}%`, height: `${((item.layout_height ?? 1) / WALL_WORKSPACE_HEIGHT) * 100}%` }}><span style={{ transform: `scale(${1 / zoom})` }} onPointerDown={(event) => startDeviceDrag(event, item)}>{item.name}</span></div>)}</div><p className="canvas-hint">Scroll to zoom · hold Space and drag, or use middle mouse, to pan.</p></section>
      <aside className="inspector"><p className="eyebrow">{selected ? 'MEDIA LAYER' : 'INSPECTOR'}</p>{selected ? <><label>Type<select value={selected.type} onChange={(event) => updateLayer(selected.id, { type: event.target.value as 'image' | 'video' })}><option value="image">Image</option><option value="video">Video</option></select></label><label>Media URL<input type="url" value={selected.content.url ?? ''} onChange={(event) => updateContent('url', event.target.value)} placeholder="https://…" /></label><label className="upload-button">Upload {selected.type}<input type="file" accept={selected.type === 'video' ? 'video/*' : 'image/*'} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file) }} /></label><label><input type="checkbox" checked={selected.lockedAspect !== false} onChange={(event) => updateLayer(selected.id, { lockedAspect: event.target.checked })} /> Lock media aspect ratio</label><button className="secondary" disabled={!activeDevices.length} onClick={() => updateLayer(selected.id, fitLayerToDevices(selected, activeDevices))}>Fit layer to selected screens</button><label>Image fit<select value={selected.content.fit ?? 'cover'} onChange={event => updateLayer(selected.id, { content: { ...selected.content, fit: event.target.value as 'cover' | 'contain' } })}><option value="cover">Fill layer (crop edges)</option><option value="contain">Show whole image</option></select></label><label>Rotation (degrees)<input type="number" value={selected.rotation ?? 0} onChange={(event) => updateLayer(selected.id, { rotation: Number(event.target.value) })} /></label><label>Scale<input type="number" min="0.1" max="5" step="0.01" value={selected.scale ?? 1} onChange={(event) => updateLayer(selected.id, { scale: Math.max(.1, Number(event.target.value)) })} /></label><div className="stack-controls"><button className="secondary" onClick={() => moveLayer('up')}>Bring forward</button><button className="secondary" onClick={() => moveLayer('down')}>Send backward</button></div><div className="position-grid"><label>x<input type="number" value={selected.x} onChange={(event) => updateLayer(selected.id, { x: Number(event.target.value) })} /></label><label>y<input type="number" value={selected.y} onChange={(event) => updateLayer(selected.id, { y: Number(event.target.value) })} /></label><label>width<input type="number" min="0" value={selected.width} onChange={(event) => updateDimension('width', Number(event.target.value))} /></label><label>height<input type="number" min="0" value={selected.height} onChange={(event) => updateDimension('height', Number(event.target.value))} /></label></div><button className="danger" onClick={removeSelected}>Remove layer</button></> : <p>Select an image or video layer to edit it.</p>}</aside>
    </div>{notice && <p className="editor-notice">{notice}</p>}
  </main>
}

export function EditorMedia({ layer, onSize }: { layer: SceneLayer; onSize: (width: number, height: number) => void }) {
  return layer.type === 'image' && layer.content.url ? <img style={{ objectFit: layer.content.fit ?? 'cover' }} src={layer.content.url} alt="" onLoad={event => onSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /> : layer.type === 'video' && layer.content.url ? <video className="editor-video" style={{ objectFit: layer.content.fit ?? 'cover' }} src={layer.content.url} autoPlay muted loop playsInline onLoadedMetadata={event => onSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} /> : <div className="media-placeholder">{layer.type === 'video' ? '▶ Video source' : '▣ Image source'}</div>
}

function Player() {
  // Local kiosk watchdog: independent of pairing, media and backend availability.
  useEffect(() => {
    let frame = 0
    const tick = () => {
      document.documentElement.dataset.playerFrame = String(performance.now())
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); delete document.documentElement.dataset.playerFrame }
  }, [])
  const playerParams = new URLSearchParams(location.search)
  const debug = playerParams.get('debug') === '1'
  const safeMode = playerParams.get('safe') === '1'
  const videosDisabled = playerParams.get('noVideo') === '1'
  const rawVideos = playerParams.get('rawVideo') === '1'
  const [pin, setPin] = useState('')
  const [device, setDevice] = useState<{ id: string; token: string } | null>(() => { try { return JSON.parse(localStorage.getItem('videowall-device') ?? 'null') } catch { return null } })
  const [scene, setScene] = useState<Scene | null>(null)
  const [status, setStatus] = useState('Enter the PIN shown in the admin dashboard.')
  // This is server epoch time minus the browser's monotonic clock. Unlike
  // Date.now(), performance.now() does not jump when NTP corrects a Pi clock.
  const [serverEpochOffsetMs, setServerEpochOffsetMs] = useState(() => Date.now() - performance.now())
  const [wallDevices, setWallDevices] = useState<Device[]>([])
  const [sceneStartedAtMs, setSceneStartedAtMs] = useState(0)

  useEffect(() => {
    if (!device || !supabase) return
    let cancelled = false
    const client = supabase
    const calibrateClock = async () => {
      // This is the same principle as NTP: take several samples and retain the
      // quickest round trip, which has the least network queueing error.
      const samples: Array<{ roundTripMs: number; epochOffsetMs: number }> = []
      for (let index = 0; index < 7; index += 1) {
        const sentAt = performance.now()
        const { data, error } = await client.rpc('get_server_time')
        const receivedAt = performance.now()
        const serverNow = data ? new Date(data as string).getTime() : NaN
        if (!error && Number.isFinite(serverNow)) {
          samples.push({ roundTripMs: receivedAt - sentAt, epochOffsetMs: serverNow + (receivedAt - sentAt) / 2 - receivedAt })
        }
      }
      if (!cancelled && samples.length) {
        samples.sort((a, b) => a.roundTripMs - b.roundTripMs)
        setServerEpochOffsetMs(samples[0].epochOffsetMs)
      }
    }
    void calibrateClock()
    const timer = window.setInterval(() => void calibrateClock(), 5 * 60 * 1000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [device])

  useEffect(() => {
    const refresh = window.setTimeout(() => location.reload(), 6 * 60 * 60 * 1000)
    return () => window.clearTimeout(refresh)
  }, [])

  useEffect(() => {
    if (!device || !supabase) return
    const client = supabase
    const refresh = async () => {
      const { data, error } = await client.rpc('get_player_state', { requested_device_id: device.id, requested_token: device.token })
      if (error) return setStatus('Connection issue — retrying…')
      if (data?.scene) setScene({ ...data.scene, layers: data.scene.layers as SceneLayer[] })
      else setScene(null)
      if (data?.devices) setWallDevices(data.devices as Device[])
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
  if (safeMode) return <main className="player-message" style={{ background: '#070a12', color: '#9bf6d2', fontFamily: 'monospace', textAlign: 'center' }}><div><strong>Videowall player base is working</strong><br /><small>Scene media is intentionally disabled for this diagnostic.</small></div></main>
  return scene ? <><ScenePreview scene={scene} player deviceId={device.id} devices={wallDevices} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} videosDisabled={videosDisabled} rawVideos={rawVideos} />{debug && <pre className="player-debug">{`device: ${device.id}\nscene: ${scene.name}\nlayers: ${scene.layers.length}\nselected for scene: ${!scene.device_ids?.length || scene.device_ids.includes(device.id)}\nstatus: ${status}\nvideos disabled: ${videosDisabled}\nraw video: ${rawVideos}`}</pre>}</> : <main className="player-message">{status}</main>
}

export function ScenePreview({ scene, player = false, deviceId, devices = [], serverEpochOffsetMs = Date.now() - performance.now(), sceneStartedAtMs = 0, videosDisabled = false, rawVideos = false, embedded = false }: { scene: Scene; player?: boolean; deviceId?: string; devices?: Device[]; serverEpochOffsetMs?: number; sceneStartedAtMs?: number; videosDisabled?: boolean; rawVideos?: boolean; embedded?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = root.current
    if (!element) return
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(([entry]) => {
      // Fractional preview sizes must survive to avoid seams between displays.
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const current = devices.find(item => item.id === deviceId)
  const activeDevices = sceneDevices(scene, devices)
  const view = player && current ? deviceRect(current) : activeDevices.length ? bounds(activeDevices.map(deviceRect)) : WORKSPACE
  const excluded = player && deviceId && scene.device_ids?.length && !scene.device_ids.includes(deviceId)
  const layers = excluded ? [] : scene.layers.filter(layer => (!deviceId || !layer.target.length || layer.target.includes(deviceId)) && (!videosDisabled || layer.type !== 'video'))
  return <div ref={root} className={player ? 'player-canvas' : 'scene-preview'} style={player ? { position: embedded ? 'relative' : 'fixed', inset: 0, width: embedded ? '100%' : '100vw', height: embedded ? '100%' : '100vh', overflow: 'hidden', background: '#000' } : { aspectRatio: `${view.width} / ${view.height}` }}>
    {!player && activeDevices.length ? activeDevices.map(device => {
      const box = deviceRect(device)
      return <div key={device.id} style={{ position: 'absolute', left: `${(box.x - view.x) / view.width * 100}%`, top: `${(box.y - view.y) / view.height * 100}%`, width: `${box.width / view.width * 100}%`, height: `${box.height / view.height * 100}%` }}>
        <ScenePreview scene={scene} devices={devices} deviceId={device.id} player embedded serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} videosDisabled={videosDisabled} rawVideos={rawVideos} />
      </div>
    }) : viewport.width > 0 && layers.map(layer => {
      const reference = layerReference(layer, scene, devices, player ? current : undefined)
      // Fit/crop/rotate in shared coordinates, then project into this viewport.
      // The viewport clips the full layer; the layer is never capped at one screen.
      return <div className="layer-plane" key={layer.id} style={{ position: 'absolute', left: 0, top: 0, width: reference.width, height: reference.height, zIndex: layer.zIndex, transformOrigin: '0 0', transform: planeTransform(reference, player && !current ? reference : view, viewport.width, viewport.height) }}>
        <Layer layer={layer} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} rawVideo={rawVideos} />
      </div>
    })}
  </div>
}

function Layer({ layer, serverEpochOffsetMs = Date.now() - performance.now(), sceneStartedAtMs = 0, rawVideo = false }: { layer: SceneLayer; serverEpochOffsetMs?: number; sceneStartedAtMs?: number; rawVideo?: boolean }) {
  const style: CSSProperties = { objectFit: layer.content.fit ?? 'cover', left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, zIndex: layer.zIndex, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` }
  const typography = { fontFamily: layer.content.fontFamily ?? "'Roboto', sans-serif", fontSize: layer.content.fontSize ? `${layer.content.fontSize / 19.2}cqw` : undefined }
  if (layer.type === 'video' && layer.content.url) return rawVideo ? <video className="media-layer" style={style} src={layer.content.url} autoPlay muted={layer.content.muted !== false} loop={layer.content.loop !== false} playsInline /> : <SyncedVideo style={style} src={layer.content.url} muted={layer.content.muted !== false} loop={layer.content.loop !== false} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} />
  if (layer.type === 'image' && layer.content.url) return <img className="media-layer" style={style} src={layer.content.url} alt="" />
  if (layer.type === 'clock') return <Clock style={style} timezone={layer.content.timezone} serverEpochOffsetMs={serverEpochOffsetMs} />
  if (layer.type === 'ticker') return <div className="ticker-layer" style={{ ...style, ...typography }}><span>{layer.content.text}</span></div>
  return <div className="text-layer" style={{ ...style, ...typography }}>{layer.content.text}</div>
}

function SyncedVideo({ style, src, muted, loop, serverEpochOffsetMs, sceneStartedAtMs }: { style: CSSProperties; src: string; muted: boolean; loop: boolean; serverEpochOffsetMs: number; sceneStartedAtMs: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const video = videoRef.current; if (!video || !sceneStartedAtMs) return
    const expectedPosition = () => {
      const elapsedSeconds = Math.max(0, (performance.now() + serverEpochOffsetMs - sceneStartedAtMs) / 1000)
      if (!video.duration || !Number.isFinite(video.duration)) return 0
      return loop ? elapsedSeconds % video.duration : Math.min(elapsedSeconds, video.duration)
    }
    const align = () => {
      if (!video.duration || !Number.isFinite(video.duration)) return
      video.currentTime = expectedPosition()
      video.playbackRate = 1
      void video.play().catch(() => undefined)
    }
    const correctDrift = () => {
      if (!video.duration || !Number.isFinite(video.duration) || video.paused) return
      const expected = expectedPosition()
      let drift = expected - video.currentTime
      if (loop && Math.abs(drift) > video.duration / 2) drift -= Math.sign(drift) * video.duration
      // Big stalls get a clean seek. Small decoder differences are corrected
      // gradually, so separate Pis converge without visible jumps.
      if (Math.abs(drift) > .18) {
        video.currentTime = expected
        video.playbackRate = 1
      } else {
        video.playbackRate = Math.max(.97, Math.min(1.03, 1 + drift * .15))
      }
    }
    video.addEventListener('loadedmetadata', align)
    align()
    const timer = window.setInterval(correctDrift, 1500)
    return () => { video.removeEventListener('loadedmetadata', align); window.clearInterval(timer) }
  }, [src, loop, serverEpochOffsetMs, sceneStartedAtMs])
  return <video className="media-layer" ref={videoRef} style={style} src={src} autoPlay muted={muted} loop={loop} playsInline />
}

function Clock({ style, timezone, serverEpochOffsetMs }: { style: CSSProperties; timezone?: string; serverEpochOffsetMs: number }) {
  const [now, setNow] = useState(() => performance.now() + serverEpochOffsetMs)
  const offsetRef = useRef(serverEpochOffsetMs)
  useEffect(() => { offsetRef.current = serverEpochOffsetMs }, [serverEpochOffsetMs])
  useEffect(() => {
    let frame = 0
    let displayedSecond = -1
    // requestAnimationFrame makes each browser repaint on the first available
    // frame after the same absolute server-time boundary.
    const tick = () => {
      const synchronizedNow = performance.now() + offsetRef.current
      const currentSecond = Math.floor(synchronizedNow / 1000)
      if (currentSecond !== displayedSecond) {
        displayedSecond = currentSecond
        setNow(synchronizedNow)
      }
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => window.cancelAnimationFrame(frame)
  }, [])
  return <time className="clock-layer" style={style}>{new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: timezone }).format(new Date(now))}</time>
}

export default App
