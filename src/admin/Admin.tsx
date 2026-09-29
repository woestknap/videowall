import { useEffect, useState } from 'react'
import { isConfigured, supabase } from '../lib/supabase'
import { bounds, deviceRect } from '../lib/wallGeometry'
import { ScenePreview } from '../rendering/ScenePreview'
import type { Device, PlaylistRuntime, Scene, SceneLayer, Wall } from '../types'
import { MediaLibrary } from '../media/MediaLibrary'
import { v2SceneCreateValues, virtualGeometryForWall } from '../lib/editorSceneGeometry'
import { physicalDeviceSaveValues, resetPhysicalPositions } from '../lib/physicalWallLayout'
import { PhysicalWallEditor } from './PhysicalWallEditor'
import { PlaylistManager } from './PlaylistManager'
import { scenesForWall, selectedSceneIdForWall } from '../lib/playlists'

const starterScene: Scene = {
  id: 'preview', name: 'Welcome', duration_seconds: 60,
  layers: [
    { id: 'welcome', type: 'text', target: [], x: 8, y: 12, width: 84, height: 40, zIndex: 1, content: { text: 'ScreenMesh is ready' } },
    { id: 'clock', type: 'clock', target: [], x: 8, y: 60, width: 45, height: 24, zIndex: 2, content: { timezone: 'Europe/Amsterdam' } },
  ],
}

function WallLayoutOverview({ devices }: { devices: Device[] }) {
  const rectangles = devices.map((device) => {
    const rect = deviceRect(device)
    return {
      device,
      rect: {
        x: Number.isFinite(rect.x) ? rect.x : 0,
        y: Number.isFinite(rect.y) ? rect.y : 0,
        width: Number.isFinite(rect.width) ? Math.max(1, rect.width) : 1,
        height: Number.isFinite(rect.height) ? Math.max(1, rect.height) : 1,
      },
    }
  })
  const wallBounds = bounds(rectangles.map(({ rect }) => rect))
  return <div className="wall-layout-overview" aria-label="Physical wall layout overview">
    <div className="wall-layout-canvas" style={{ aspectRatio: `${wallBounds.width} / ${wallBounds.height}` }}>
      {rectangles.map(({ device, rect }, index) => <div className="wall-layout-screen" key={device.id} title={device.name} style={{ left: `${(rect.x - wallBounds.x) / wallBounds.width * 100}%`, top: `${(rect.y - wallBounds.y) / wallBounds.height * 100}%`, width: `${rect.width / wallBounds.width * 100}%`, height: `${rect.height / wallBounds.height * 100}%` }}><span>{index + 1}</span><strong>{device.name}</strong></div>)}
    </div>
  </div>
}

function deviceStatus(device: Device) {
  const lastSeenAt = device.last_seen_at ? Date.parse(device.last_seen_at) : NaN
  if (!Number.isFinite(lastSeenAt)) return { label: 'Waiting to be seen', tone: 'waiting' }
  return Date.now() - lastSeenAt <= 10 * 60 * 1000
    ? { label: 'Recently seen', tone: 'recent' }
    : { label: 'Not seen recently', tone: 'stale' }
}

function DashboardDeviceRow({ device, index, onRename, onRemove }: { device: Device; index: number; onRename: (device: Device) => void; onRemove: (device: Device) => void }) {
  const status = deviceStatus(device)
  return <div className="dashboard-device-row"><span>{index + 1}</span><div><strong>{device.name}</strong><small className={`device-status is-${status.tone}`}>{status.label}</small></div><div className="dashboard-device-maintenance"><span>Maintenance</span><button className="sm-button sm-button-secondary maintenance-action" onClick={() => onRename(device)}>Rename</button><button className="sm-button sm-button-danger maintenance-action" onClick={() => onRemove(device)}>Remove Pi</button></div></div>
}

export function Admin() {
  const [walls, setWalls] = useState<Wall[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [scenes, setScenes] = useState<Scene[]>([])
  const [activeWall, setActiveWall] = useState<string>('')
  const [selectedSceneId, setSelectedSceneId] = useState<string>('')
  const [liveSceneId, setLiveSceneId] = useState<string>('')
  const [playlistRuntime, setPlaylistRuntime] = useState<PlaylistRuntime | null>(null)
  const [pin, setPin] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [physicalLayoutDirty, setPhysicalLayoutDirty] = useState(false)
  const selectedWall = walls.find((wall) => wall.id === activeWall)
  const selectedWallScenes = scenesForWall(scenes, activeWall)
  const selectedScene = selectedWallScenes.find((scene) => scene.id === selectedSceneId) ?? starterScene
  const liveScene = selectedWallScenes.find((scene) => scene.id === liveSceneId)
  const selectedVirtualGeometry = selectedWall ? virtualGeometryForWall(selectedWall, devices) : null
  const selectedSceneRevisionMismatch = selectedScene.geometry_version === 2 && selectedScene.wall_id === activeWall && selectedVirtualGeometry?.status === 'valid' && selectedScene.wall_geometry_revision !== selectedVirtualGeometry.geometryRevision
  const recentDeviceCount = devices.filter((device) => deviceStatus(device).tone === 'recent').length
  const includedDeviceCount = devices.filter((device) => device.included_in_wall !== false).length

  useEffect(() => {
    if (!supabase) return
    void (async () => {
      const [{ data: wallData }, { data: sceneData }] = await Promise.all([
        supabase.from('walls').select('id,name,layout_mode,virtual_pixels_per_mm').order('created_at'),
        supabase.from('scenes').select('id,name,layers,duration_seconds,device_ids,wall_id,geometry_version,canvas_width_px,canvas_height_px,wall_geometry_revision').order('created_at'),
      ])
      setWalls(wallData ?? [])
      setScenes((sceneData ?? []).map((scene) => ({ ...scene, layers: scene.layers as SceneLayer[] })))
      if (wallData?.[0]) setActiveWall(wallData[0].id)
    })()
  }, [])
  useEffect(() => {
    setSelectedSceneId(current => selectedSceneIdForWall(scenes, activeWall, current))
  }, [activeWall, scenes])
  useEffect(() => {
    if (!supabase || !activeWall) { setDevices([]); setLiveSceneId(''); setPlaylistRuntime(null); return }
    const client = supabase
    void client.from('devices').select('id,name,wall_id,last_seen_at,width,height,layout_x,layout_y,layout_width,layout_height,auto_size,included_in_wall').eq('wall_id', activeWall).order('created_at').then(({ data }) => { setDevices(data ?? []); setPhysicalLayoutDirty(false) })
    const refreshLiveScene = () => void client.from('wall_state').select('active_scene_id').eq('wall_id', activeWall).maybeSingle().then(({ data }) => setLiveSceneId(data?.active_scene_id ?? ''))
    refreshLiveScene()
    const timer = window.setInterval(refreshLiveScene, 2000)
    return () => window.clearInterval(timer)
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
  async function renameDevice(device: Device) {
    if (!supabase) return
    const enteredName = prompt('Rename paired screen', device.name)
    if (enteredName === null) return
    const newName = enteredName.trim()
    if (!newName) return setNotice('Device name cannot be empty.')
    const { error } = await supabase.from('devices').update({ name: newName }).eq('id', device.id)
    if (error) return setNotice(error.message)
    setDevices((current) => current.map((item) => item.id === device.id ? { ...item, name: newName } : item))
    setNotice(`Device renamed to ${newName}.`)
  }
  async function goLive(scene: Scene) {
    if (!supabase || !activeWall || scene.id === 'preview') return setNotice('Create and save a scene first.')
    if (scene.geometry_version === 2 && scene.wall_id !== activeWall) return setNotice('This virtual-pixel scene belongs to a different wall.')
    const { error } = await supabase.rpc('go_live_manual', { requested_wall_id: activeWall, requested_scene_id: scene.id })
    if (!error) setLiveSceneId(scene.id)
    if (!error) setPlaylistRuntime(current => current ? { ...current, status: 'STOPPED', phase: 'DISPLAYING' } : null)
    setNotice(error ? error.message : `${scene.name} is live.`)
  }
  async function signOut() {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) setNotice(`Could not sign out: ${error.message}`)
  }
  function selectPreviewScene(sceneId: string) {
    setSelectedSceneId(sceneId)
  }
  function updatePhysicalDevice(deviceId: string, change: Partial<Device>) {
    setDevices(current => current.map(device => device.id === deviceId ? { ...device, ...change, auto_size: false } : device))
    setPhysicalLayoutDirty(true)
  }
  function resetPhysicalLayout() {
    if (!confirm('Reset physical screen positions to a simple horizontal arrangement? Width and height measurements, viewport resolution, scenes and media will not change.')) return
    setDevices(current => resetPhysicalPositions(current))
    setPhysicalLayoutDirty(true)
    setNotice('Physical positions reset locally. Review the measurements, then save the physical layout.')
  }
  async function savePhysicalLayout() {
    if (!supabase || selectedWall?.layout_mode !== 'physical') return
    const database = supabase
    const values = devices.map(device => ({ device, values: physicalDeviceSaveValues(device) }))
    if (values.some(item => !item.values)) return setNotice('Every physical screen needs finite X, Y, Width and Height values; dimensions must be greater than zero.')
    const results = await Promise.all(values.map(({ device, values: update }) => database.from('devices').update(update!).eq('id', device.id)))
    const error = results.find(result => result.error)?.error
    if (error) return setNotice(error.message)
    setPhysicalLayoutDirty(false)
    setDevices(current => current.map(device => ({ ...device, auto_size: false })))
    setNotice('Physical wall calibration saved. Existing V2 scenes keep their saved canvas and may show a revision warning.')
  }
  async function createScene(geometryVersion: 1 | 2) {
    if (!supabase) return
    const name = prompt('Scene name', 'New scene')?.trim()
    if (!name) return
    const fields = 'id,name,layers,duration_seconds,device_ids,wall_id,geometry_version,canvas_width_px,canvas_height_px,wall_geometry_revision'
    const result = geometryVersion === 1
      ? await supabase.from('scenes').insert({ name, layers: starterScene.layers, duration_seconds: 60, device_ids: [], wall_id: activeWall || null, geometry_version: 1 }).select(fields).single()
      : await (async () => {
        const values = v2SceneCreateValues(name, selectedWall, devices)
        if (values.status === 'invalid') return { data: null, error: { message: values.reason } }
        return supabase.from('scenes').insert(values.values).select(fields).single()
      })()
    const { data, error } = result
    if (error) return setNotice(error.message)
    if (!data) return setNotice('Scene creation failed.')
    const newScene = { ...data, layers: data.layers as SceneLayer[] }
    setScenes((existing) => [...existing, newScene]); setSelectedSceneId(newScene.id)
  }
  async function deleteScene(scene: Scene) {
    if (!supabase || scene.id === 'preview') return
    if (!confirm(`Delete scene “${scene.name}”? This cannot be undone.`)) return
    const { error } = await supabase.from('scenes').delete().eq('id', scene.id)
    if (error) return setNotice(error.message)
    const remaining = scenes.filter((item) => item.id !== scene.id)
    setScenes(remaining)
    setSelectedSceneId(selectedSceneIdForWall(remaining, activeWall, selectedSceneId)); setNotice('Scene deleted. Playlist entries using it were removed, and any matching playlist loading-scene setting was cleared.')
  }
  return <main className="admin-shell screenmesh-light-preview">
    <header className="dashboard-header"><div><p className="eyebrow">PERSONAL DISPLAY CONTROL</p><h1>ScreenMesh</h1></div><div className="dashboard-header-actions"><a className="sm-button sm-button-secondary" href="?player=1" target="_blank" rel="noreferrer">Open player <span aria-hidden="true">↗</span></a>{supabase && <button className="sm-button sm-button-secondary" onClick={() => void signOut()}>Sign out</button>}</div></header>
    {!isConfigured && <div className="alert">Add your Supabase values to <code>.env</code> using <code>.env.example</code>, then apply the migration in <code>supabase/migrations</code>.</div>}
    <section className="dashboard-section dashboard-wall-section" aria-labelledby="current-wall-heading">
      <div className="dashboard-section-heading"><div><p className="eyebrow">CONTROL CONTEXT</p><h2 id="current-wall-heading">Current wall</h2></div><p>Choose the display wall you want to operate.</p></div>
      <div className="toolbar dashboard-toolbar sm-card sm-card-alt">
        <label className="dashboard-wall-picker sm-field">Wall<select value={activeWall} onChange={(event) => setActiveWall(event.target.value)}><option value="">Select a wall</option>{walls.map((wall) => <option key={wall.id} value={wall.id}>{wall.name}</option>)}</select></label>
        <div className="dashboard-wall-actions"><button className="sm-button sm-button-secondary" onClick={() => void createWall()}>+ Add wall</button><button className="sm-button" disabled={!activeWall} onClick={() => void createPin()}>Pair screen</button></div>
        {pin && <div className="pin"><span>Pairing PIN</span><strong>{pin}</strong><small>Open {location.origin}/?player=1</small></div>}
        <div className="dashboard-wall-maintenance"><span>Maintenance</span><button className="sm-button sm-button-danger" disabled={!activeWall} onClick={() => void deleteWall()}>Delete wall</button></div>
      </div>
    </section>
    {notice && <p className="notice" role="status">{notice}</p>}

    <section className="dashboard-section" aria-labelledby="output-scenes-heading">
      <div className="dashboard-section-heading"><div><p className="eyebrow">DAILY CONTROL</p><h2 id="output-scenes-heading">Current output + scenes</h2></div><p>Preview a scene, edit it, or send it to the selected wall.</p></div>
      <div className="dashboard-workspace">
        <article className="panel sm-card dashboard-preview-panel">
          <div className="panel-heading"><div><p className="eyebrow">CURRENT OUTPUT</p><h3>{selectedScene.name}</h3></div><button className="sm-button" disabled={!activeWall || selectedScene.id === 'preview'} onClick={() => void goLive(selectedScene)}>Go live</button></div>
          <div className="dashboard-output-status"><span className="sm-status sm-status-selected">Selected for preview</span>{selectedScene.id === liveSceneId && <span className="sm-status sm-status-success">Live now</span>}</div>
          {selectedSceneRevisionMismatch ? <p className="dashboard-wall-revision-message">Wall layout changed - <a href={`?editor=${selectedScene.id}`}>open scene to update</a>.</p> : <ScenePreview key={selectedScene.id} scene={selectedScene} devices={devices} virtualWallGeometry={selectedScene.wall_id === activeWall ? selectedVirtualGeometry : null} />}
          <p className="dashboard-current-live">{liveScene ? selectedScene.id === liveScene.id ? `${liveScene.name} is currently live on ${selectedWall?.name ?? 'this wall'}.` : <><strong>{liveScene.name}</strong> is currently live. Going live will replace it with <strong>{selectedScene.name}</strong>.</> : 'No scene is currently live on this wall.'}</p>
          {playlistRuntime && playlistRuntime.status !== 'STOPPED' && <p className="dashboard-current-live"><strong>Playlist: {playlistRuntime.playlist_name}</strong> · {playlistRuntime.status} · {playlistRuntime.phase} · {Math.max(0, playlistRuntime.current_index) + 1} / {playlistRuntime.item_count}</p>}
        </article>

        <article className="panel sm-card scenes dashboard-scenes-panel">
          <div className="panel-heading"><div><p className="eyebrow">SCENE LIBRARY</p><h3>Scenes</h3></div><div className="scene-create-actions"><button className="sm-button sm-button-secondary" disabled={!activeWall} onClick={() => void createScene(1)}>+ Legacy</button><button className="sm-button sm-button-secondary" disabled={!activeWall} onClick={() => void createScene(2)}>+ Virtual-pixel</button></div></div>
          {selectedWallScenes.length ? <div className="dashboard-scene-list">{selectedWallScenes.map((scene) => {
            const selected = scene.id === selectedSceneId
            const live = scene.id === liveSceneId
            return <div className={`dashboard-scene-card ${selected ? 'is-selected' : ''} ${live ? 'is-live' : ''}`} key={scene.id} role="button" tabIndex={0} aria-pressed={selected} aria-label={`Select ${scene.name} for preview`} onClick={() => selectPreviewScene(scene.id)} onKeyDown={(event) => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
              event.preventDefault()
              selectPreviewScene(scene.id)
            }}>
              <div className="dashboard-scene-card-heading"><strong className="scene-select">{scene.name}</strong><div>{selected && <span className="sm-status sm-status-selected">Selected</span>}{live && <span className="sm-status sm-status-success">Live now</span>}</div></div>
              <small>{scene.layers.length} layer{scene.layers.length === 1 ? '' : 's'} · {scene.duration_seconds}s · Geometry V{scene.geometry_version ?? 1}</small>
              <div className="dashboard-scene-actions" onClick={(event) => event.stopPropagation()}><a className="sm-button sm-button-secondary" href={`?editor=${scene.id}`}>Edit</a><button className="sm-button" onClick={() => void goLive(scene)}>Go live</button><button className="sm-button sm-button-danger" onClick={() => void deleteScene(scene)}>Delete</button></div>
            </div>
          })}</div> : <p className="dashboard-empty-state">No scenes belong to this wall yet. Unassigned legacy scenes are not shown.</p>}
        </article>
      </div>
    </section>

    <PlaylistManager wallId={activeWall} scenes={scenes} onNotice={setNotice} onRuntimeChange={setPlaylistRuntime} />

    <section className="dashboard-section" aria-labelledby="devices-heading">
      <div className="dashboard-section-heading"><div><p className="eyebrow">WALL HEALTH</p><h2 id="devices-heading">Devices + wall setup</h2></div><p>Review player health before opening detailed calibration controls.</p></div>
      <article className={`panel sm-card dashboard-screens-panel ${selectedWall?.layout_mode === 'physical' ? 'physical-layout-panel' : ''}`}>
        <div className="dashboard-health-summary"><span><strong>{devices.length}</strong>Total screens</span><span className={recentDeviceCount ? 'is-healthy' : ''}><strong>{recentDeviceCount}</strong>Recently online</span><span><strong>{includedDeviceCount}</strong>Included in wall</span><span><strong>{selectedWall?.layout_mode === 'physical' ? 'Physical' : selectedWall ? 'Viewport' : '—'}</strong>Layout mode</span></div>
        <div className="panel-heading"><div><p className="eyebrow">{selectedWall?.name ?? 'NO WALL SELECTED'}</p><h3>{selectedWall?.layout_mode === 'physical' ? 'Physical wall calibration' : 'Wall layout'}</h3></div><button className="sm-button sm-button-secondary" disabled={!activeWall} onClick={() => void createPin()}>Pair screen</button></div>
        {devices.length ? <>{selectedWall?.layout_mode === 'physical' ? <PhysicalWallEditor wall={selectedWall} devices={devices} geometry={selectedVirtualGeometry} dirty={physicalLayoutDirty} onChange={updatePhysicalDevice} onReset={resetPhysicalLayout} onSave={() => void savePhysicalLayout()} /> : <WallLayoutOverview devices={devices} />}<div className="dashboard-device-list">{devices.map((device, index) => <DashboardDeviceRow device={device} index={index} key={device.id} onRename={renameDevice} onRemove={deleteDevice} />)}</div></> : <p className="dashboard-empty-state">Pair a Pi to start building your wall.</p>}
      </article>
    </section>

    <section className="dashboard-section dashboard-media-section" aria-label="Media Library"><MediaLibrary mode="manage" /></section>

    <section className="dashboard-section dashboard-tools-section" aria-labelledby="tools-heading">
      <article className="panel sm-card sm-card-alt dashboard-downloads-panel"><div><p className="eyebrow">TOOLS</p><h2 id="tools-heading">ScreenMesh conversion tools</h2><p>Convert videos locally into a playback format optimized for ScreenMesh and Raspberry Pi players.</p></div><div className="dashboard-download-actions"><a className="sm-button sm-button-secondary" href="/downloads/ScreenMesh-Convert-Windows.zip" download>Download for Windows</a><a className="sm-button sm-button-secondary" href="/downloads/ScreenMesh-Convert-macOS.command" download>Download for macOS</a></div></article>
    </section>
  </main>
}
