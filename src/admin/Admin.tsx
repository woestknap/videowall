import { useEffect, useState } from 'react'
import { isConfigured, supabase } from '../lib/supabase'
import { bounds, deviceRect } from '../lib/wallGeometry'
import { ScenePreview } from '../rendering/ScenePreview'
import type { Device, Scene, SceneLayer, Wall } from '../types'

const starterScene: Scene = {
  id: 'preview', name: 'Welcome', duration_seconds: 60,
  layers: [
    { id: 'welcome', type: 'text', target: [], x: 8, y: 12, width: 84, height: 40, zIndex: 1, content: { text: 'Videowall is ready' } },
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

function DashboardDeviceRow({ device, index, onRemove }: { device: Device; index: number; onRemove: (device: Device) => void }) {
  const status = deviceStatus(device)
  return <div className="dashboard-device-row"><span>{index + 1}</span><div><strong>{device.name}</strong><small className={`device-status is-${status.tone}`}>{status.label}</small></div><div className="dashboard-device-maintenance"><span>Maintenance</span><button className="maintenance-action" onClick={() => onRemove(device)}>Remove Pi</button></div></div>
}

export function Admin() {
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
    void supabase.from('devices').select('id,name,wall_id,last_seen_at,width,height,layout_x,layout_y,layout_width,layout_height,auto_size').eq('wall_id', activeWall).order('created_at').then(({ data }) => setDevices(data ?? []))
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
  return <main className="admin-shell">
    <header className="dashboard-header"><div><p className="eyebrow">PERSONAL DISPLAY CONTROL</p><h1>Videowall</h1></div><a href="?player=1" target="_blank" rel="noreferrer">Open player ↗</a></header>
    {!isConfigured && <div className="alert">Add your Supabase values to <code>.env</code> using <code>.env.example</code>, then apply the migration in <code>supabase/migrations</code>.</div>}
    <section className="toolbar dashboard-toolbar">
      <div className="dashboard-wall-picker"><p className="eyebrow">CURRENT WALL</p><label>Wall <select value={activeWall} onChange={(event) => setActiveWall(event.target.value)}><option value="">Select a wall</option>{walls.map((wall) => <option key={wall.id} value={wall.id}>{wall.name}</option>)}</select></label></div>
      <div className="dashboard-wall-actions"><button className="secondary" onClick={() => void createWall()}>+ Wall</button><button disabled={!activeWall} onClick={() => void createPin()}>Pair screen</button></div>
      {pin && <div className="pin">PIN <strong>{pin}</strong><small>Open {location.origin}/?player=1</small></div>}
      <div className="dashboard-wall-maintenance"><span>Maintenance</span><button className="maintenance-action" disabled={!activeWall} onClick={() => void deleteWall()}>Delete wall</button></div>
    </section>
    {notice && <p className="notice">{notice}</p>}
    <section className="dashboard-grid">
      <article className="panel dashboard-preview-panel"><div className="panel-heading"><div><p className="eyebrow">SELECTED SCENE PREVIEW</p><h2>{activeScene.name}</h2></div><button disabled={!activeWall} onClick={() => void publish(activeScene)}>Publish</button></div><ScenePreview scene={activeScene} devices={devices} /></article>
      <article className="panel dashboard-screens-panel"><div className="panel-heading"><div><p className="eyebrow">{selectedWall?.name ?? 'NO WALL'}</p><h2>Layout</h2></div><span>{devices.length} screens</span></div>{devices.length ? <><WallLayoutOverview devices={devices} /><div className="dashboard-device-list">{devices.map((device, index) => <DashboardDeviceRow device={device} index={index} key={device.id} onRemove={deleteDevice} />)}</div></> : <p>Pair a Pi to start building your wall.</p>}</article>
      <article className="panel scenes"><div className="panel-heading"><h2>Scenes</h2><button className="secondary" onClick={() => void createScene()}>+ Scene</button></div>{scenes.length ? scenes.map((scene) => <div className={`scene-row ${scene.id === activeScene.id ? 'selected' : ''}`} key={scene.id}><button className="scene-select" onClick={() => setSelectedSceneId(scene.id)}>{scene.name}</button><small>{scene.layers.length} layers · {scene.duration_seconds}s</small><a className="edit-link" href={`?editor=${scene.id}`}>Edit</a><button onClick={() => void publish(scene)}>Go live</button><button className="danger" onClick={() => void deleteScene(scene)}>Delete</button></div>) : <p>Create your first reusable scene.</p>}</article>
    </section>
  </main>
}
