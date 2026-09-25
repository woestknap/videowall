import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react'
import { ScreenLayoutControls } from '../ScreenLayoutControls'
import { fitEditorView, panForCursorZoom } from '../lib/editorZoom'
import { supabase } from '../lib/supabase'
import { addOrQueueIceCandidate, flushIceCandidates, webRtcConfiguration, type PendingIceCandidate } from '../lib/webrtc'
import { WALL_WORKSPACE_HEIGHT, WALL_WORKSPACE_WIDTH, bounds, deviceRect, fitLayerToDevices, layerReference, sceneDevices, toWorkspaceLayer } from '../lib/wallGeometry'
import type { Device, Scene, SceneLayer } from '../types'
import { parseServerSignalingMessage, scopedClientMessage, SIGNALING_VERSION, type AuthenticatedMessage } from '../signalingProtocol'

function LiveCameraPreview({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    void video.play().catch(() => undefined)
    return () => { if (video.srcObject === stream) video.srcObject = null }
  }, [stream])
  return <video ref={videoRef} className="editor-video" autoPlay muted playsInline />
}

export function EditorMedia({ layer, onSize, liveStream, liveLayerId }: { layer: SceneLayer; onSize: (width: number, height: number) => void; liveStream?: MediaStream | null; liveLayerId?: string | null }) {
  if (layer.type === 'live') return liveStream && liveLayerId === layer.id ? <LiveCameraPreview stream={liveStream} /> : <div className="media-placeholder">Live input · preview disabled</div>
  return layer.type === 'image' && layer.content.url ? <img style={{ objectFit: layer.content.fit ?? 'cover' }} src={layer.content.url} alt="" onLoad={event => onSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /> : layer.type === 'video' && layer.content.url ? <video className="editor-video" style={{ objectFit: layer.content.fit ?? 'cover' }} src={layer.content.url} autoPlay muted loop playsInline onLoadedMetadata={event => onSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} /> : <div className="media-placeholder">{layer.type === 'video' ? '▶ Video source' : '▣ Image source'}</div>
}

function layerLabel(layer: SceneLayer): string {
  const fallback = `${layer.type[0].toUpperCase()}${layer.type.slice(1)} layer`
  if (layer.type === 'image' || layer.type === 'video') {
    if (!layer.content.url?.trim()) return fallback
    try {
      const pathname = new URL(layer.content.url, window.location.href).pathname
      const filename = decodeURIComponent(pathname.split('/').pop() ?? '').replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '')
      return filename || fallback
    } catch {
      return fallback
    }
  }
  if (layer.type === 'clock') return layer.content.timezone?.trim() || fallback
  if (layer.type === 'live') return 'Live input'
  return layer.content.text?.trim().replace(/\s+/g, ' ').slice(0, 48) || fallback
}

type TargetSignalingState = 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'error' | 'ended'
type TargetStatus = {
  deviceId: string
  name: string
  signaling: TargetSignalingState
  peerReady: boolean
  connectionState: RTCPeerConnectionState | 'idle'
  iceConnectionState: RTCIceConnectionState | 'idle'
}
type TargetRuntime = {
  device: Device
  socket: WebSocket
  scope: AuthenticatedMessage | null
  peer: RTCPeerConnection | null
  pendingIceCandidates: PendingIceCandidate[]
  stopped: boolean
}

export function SceneEditorPage({ sceneId }: { sceneId: string }) {
  const [scene, setScene] = useState<Scene | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [drag, setDrag] = useState<{ id: string; offsetX: number; offsetY: number; deviceId?: string } | null>(null)
  const [deviceDrag, setDeviceDrag] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const [layoutDirty, setLayoutDirty] = useState(false)
  const [devicesLoaded, setDevicesLoaded] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const initialFitSceneRef = useRef<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panDrag, setPanDrag] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const [cameraLayerId, setCameraLayerId] = useState<string | null>(null)
  const [cameraError, setCameraError] = useState('')
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const [liveSessionStatus, setLiveSessionStatus] = useState('Session not started')
  const [liveSessionActive, setLiveSessionActive] = useState(false)
  const [targetStatuses, setTargetStatuses] = useState<Record<string, TargetStatus>>({})
  const targetRuntimesRef = useRef<Map<string, TargetRuntime>>(new Map())
  useEffect(() => { if (!supabase) return; void supabase.from('scenes').select('id,name,layers,duration_seconds,device_ids').eq('id', sceneId).single().then(({ data, error }) => { if (error) return setNotice(error.message); const loaded = { ...data, layers: data.layers as SceneLayer[] }; setScene(loaded); setSelectedId(loaded.layers[0]?.id ?? '') }) }, [sceneId])
  useEffect(() => { if (supabase) void supabase.from('devices').select('id,name,wall_id,last_seen_at,width,height,layout_x,layout_y,layout_width,layout_height,auto_size').order('layout_y').order('layout_x').then(({ data, error }) => { if (error) { setNotice(error.message); return }; setDevices(data ?? []); setDevicesLoaded(true) }) }, [])
  useEffect(() => { const keyDown = (event: KeyboardEvent) => { if (event.code === 'Space' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); setSpaceHeld(true) } }; const keyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false) }; window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); return () => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp) } }, [])
  useEffect(() => () => { cameraStreamRef.current?.getTracks().forEach(track => track.stop()) }, [])
  useEffect(() => () => stopLiveSession(false), [])
  useEffect(() => {
    if (!scene || !devicesLoaded || initialFitSceneRef.current === scene.id) return
    const workspace = stageRef.current?.parentElement
    const active = sceneDevices(scene, devices)
    if (!workspace || !active.length) {
      if (!active.length) initialFitSceneRef.current = scene.id
      return
    }
    const fitInitialView = () => {
      const stage = stageRef.current
      if (!stage) return
      const controls = workspace.querySelector<HTMLElement>('.canvas-controls')
      const hint = workspace.querySelector<HTMLElement>('.canvas-hint')
      const view = fitEditorView({ bounds: bounds(active.map(deviceRect)), workspace: { width: workspace.clientWidth, height: workspace.clientHeight - (controls?.offsetHeight ?? 0) - (hint?.offsetHeight ?? 0) }, stage: { width: stage.clientWidth, height: stage.clientHeight }, wall: { width: WALL_WORKSPACE_WIDTH, height: WALL_WORKSPACE_HEIGHT } })
      if (!view) return
      setZoom(view.zoom)
      setPan(view.pan)
      initialFitSceneRef.current = scene.id
      observer.disconnect()
    }
    const observer = new ResizeObserver(fitInitialView)
    observer.observe(workspace)
    fitInitialView()
    return () => observer.disconnect()
  }, [scene, devices, devicesLoaded])
  if (!scene || !devicesLoaded) return <main className="player-message">{notice || 'Loading scene editor…'}</main>
  const currentScene = { ...scene, layers: scene.layers.map(layer => toWorkspaceLayer(layer, scene, devices)) }
  const activeDevices = sceneDevices(currentScene, devices)
  const selected = currentScene.layers.find((layer) => layer.id === selectedId) ?? null
  const selectedLiveTargets = selected?.type === 'live' ? activeDevices.filter(device => !selected.target.length || selected.target.includes(device.id)) : []
  const connectedTargetCount = Object.values(targetStatuses).filter(status => status.connectionState === 'connected').length
  const layersByStack = currentScene.layers.map((layer, index) => ({ layer, index })).sort((a, b) => b.layer.zIndex - a.layer.zIndex || a.index - b.index)
  const isSceneDevice = (deviceId: string) => !currentScene.device_ids?.length || currentScene.device_ids.includes(deviceId)
  async function listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) { setCameraError('Camera devices are unavailable in this browser.'); return [] }
    try {
      const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput')
      setCameraDevices(cameras)
      setSelectedCameraId(current => cameras.some(device => device.deviceId === current) ? current : cameras[0]?.deviceId ?? '')
      setCameraError(cameras.length ? '' : 'No video inputs found.')
      return cameras
    } catch {
      setCameraError('Camera devices could not be listed.')
      return []
    }
  }
  function stopCamera() {
    cameraStreamRef.current?.getTracks().forEach(track => track.stop())
    cameraStreamRef.current = null
    setCameraStream(null)
    setCameraLayerId(null)
    if (targetRuntimesRef.current.size) stopLiveSession()
  }
  function updateTargetStatus(deviceId: string, change: Partial<TargetStatus>) {
    setTargetStatuses(current => current[deviceId] ? { ...current, [deviceId]: { ...current[deviceId], ...change } } : current)
  }
  function closeTargetPeer(runtime: TargetRuntime) {
    const peer = runtime.peer
    runtime.peer = null
    runtime.pendingIceCandidates.splice(0)
    if (!peer) return
    peer.onicecandidate = null
    peer.onconnectionstatechange = null
    peer.oniceconnectionstatechange = null
    peer.close()
  }
  function sendWebRtcMessage<T extends 'offer' | 'ice-candidate'>(runtime: TargetRuntime, type: T, payload: T extends 'offer' ? { sdp: string } : { candidate: string | null; sdpMid: string | null; sdpMLineIndex: number | null }) {
    if (runtime.socket.readyState !== WebSocket.OPEN || !runtime.scope) throw new Error('Signaling session is unavailable')
    runtime.socket.send(JSON.stringify(scopedClientMessage(runtime.scope, type, payload)))
  }
  async function startEditorPeerConnection(runtime: TargetRuntime) {
    const scope = runtime.scope
    const stream = cameraStreamRef.current
    const videoTracks = stream?.getVideoTracks().filter(track => track.readyState === 'live') ?? []
    if (!scope || !stream || !videoTracks.length) { updateTargetStatus(runtime.device.id, { connectionState: 'failed' }); return }
    closeTargetPeer(runtime)
    updateTargetStatus(runtime.device.id, { connectionState: 'new', iceConnectionState: 'new' })
    const peer = new RTCPeerConnection(webRtcConfiguration(import.meta.env.VITE_WEBRTC_STUN_URLS))
    runtime.peer = peer
    peer.onicecandidate = event => {
      try {
        sendWebRtcMessage(runtime, 'ice-candidate', event.candidate ? { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex } : { candidate: null, sdpMid: null, sdpMLineIndex: null })
      } catch { updateTargetStatus(runtime.device.id, { signaling: 'error' }) }
    }
    peer.onconnectionstatechange = () => {
      if (peer !== runtime.peer) return
      updateTargetStatus(runtime.device.id, { connectionState: peer.connectionState })
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        updateTargetStatus(runtime.device.id, { signaling: 'error', peerReady: false })
        stopTargetRuntime(runtime, true)
      }
    }
    peer.oniceconnectionstatechange = () => { if (peer === runtime.peer) updateTargetStatus(runtime.device.id, { iceConnectionState: peer.iceConnectionState }) }
    for (const track of videoTracks) peer.addTrack(track, stream)
    const offer = await peer.createOffer()
    if (peer !== runtime.peer) return
    await peer.setLocalDescription(offer)
    if (!peer.localDescription?.sdp) throw new Error('Offer SDP was not created')
    sendWebRtcMessage(runtime, 'offer', { sdp: peer.localDescription.sdp })
    updateTargetStatus(runtime.device.id, { connectionState: 'connecting' })
  }
  function stopTargetRuntime(runtime: TargetRuntime, notifyPeer: boolean) {
    if (runtime.stopped) return
    runtime.stopped = true
    if (notifyPeer && runtime.scope && runtime.socket.readyState === WebSocket.OPEN) {
      try { runtime.socket.send(JSON.stringify(scopedClientMessage(runtime.scope, 'session-ended', { reason: 'controller-stopped' }))) } catch { /* socket cleanup continues */ }
    }
    closeTargetPeer(runtime)
    try { runtime.socket.close(1000, 'controller-stopped') } catch { /* socket may still be connecting */ }
    if (targetRuntimesRef.current.get(runtime.device.id) === runtime) targetRuntimesRef.current.delete(runtime.device.id)
  }
  function stopLiveSession(updateUi = true) {
    const runtimes = [...targetRuntimesRef.current.values()]
    for (const runtime of runtimes) stopTargetRuntime(runtime, true)
    targetRuntimesRef.current.clear()
    if (updateUi) {
      setTargetStatuses(current => Object.fromEntries(Object.entries(current).map(([id, status]) => [id, { ...status, signaling: 'ended', peerReady: false, connectionState: 'closed', iceConnectionState: 'closed' }])))
      setLiveSessionActive(false)
      setLiveSessionStatus('Session ended')
    }
  }
  function startTargetSession(device: Device, liveSourceId: string, accessToken: string, signalingUrl: string) {
    let socket: WebSocket
    try { socket = new WebSocket(signalingUrl) } catch { updateTargetStatus(device.id, { signaling: 'error' }); return }
    const runtime: TargetRuntime = { device, socket, scope: null, peer: null, pendingIceCandidates: [], stopped: false }
    targetRuntimesRef.current.set(device.id, runtime)
    socket.addEventListener('open', () => { if (!runtime.stopped) socket.send(JSON.stringify({ version: SIGNALING_VERSION, type: 'auth', role: 'editor', accessToken, wallId: device.wall_id, targetDeviceId: device.id, liveSourceId })) })
    socket.addEventListener('message', event => { void (async () => {
      if (typeof event.data !== 'string' || runtime.stopped) return
      const message = parseServerSignalingMessage(event.data)
      if (!message) return updateTargetStatus(device.id, { signaling: 'error' })
      if (message.type === 'authenticated' && message.role === 'editor') {
        runtime.scope = message
        updateTargetStatus(device.id, { signaling: 'waiting' })
      } else if (message.type === 'peer-ready') {
        if (!runtime.scope || message.sessionId !== runtime.scope.sessionId) return
        updateTargetStatus(device.id, { signaling: 'connected', peerReady: true })
        await startEditorPeerConnection(runtime)
      } else if (message.type === 'answer') {
        if (!runtime.peer) return
        await runtime.peer.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp })
        await flushIceCandidates(runtime.peer, runtime.pendingIceCandidates)
      } else if (message.type === 'ice-candidate') {
        const candidate = message.payload.candidate === null ? null : { candidate: message.payload.candidate, sdpMid: message.payload.sdpMid, sdpMLineIndex: message.payload.sdpMLineIndex }
        await addOrQueueIceCandidate(runtime.peer, candidate, runtime.pendingIceCandidates)
      } else if (message.type === 'session-ended') {
        if (message.payload.reason === 'player-left') {
          const retainMediaPeer = runtime.peer?.connectionState === 'connected' || runtime.peer?.connectionState === 'disconnected'
          if (retainMediaPeer) updateTargetStatus(device.id, { signaling: 'waiting' })
          else {
            closeTargetPeer(runtime)
            updateTargetStatus(device.id, { signaling: 'waiting', peerReady: false, connectionState: 'idle', iceConnectionState: 'idle' })
          }
        } else {
          updateTargetStatus(device.id, { signaling: 'ended', peerReady: false, connectionState: 'closed', iceConnectionState: 'closed' })
          stopTargetRuntime(runtime, false)
        }
      } else if (message.type === 'error') {
        updateTargetStatus(device.id, { signaling: 'error', connectionState: 'idle', iceConnectionState: 'idle' })
        stopTargetRuntime(runtime, false)
      }
    })().catch(() => { updateTargetStatus(device.id, { signaling: 'error', connectionState: 'failed' }); stopTargetRuntime(runtime, true) }) })
    socket.addEventListener('error', () => { closeTargetPeer(runtime); updateTargetStatus(device.id, { signaling: 'error' }) })
    socket.addEventListener('close', () => {
      closeTargetPeer(runtime)
      if (targetRuntimesRef.current.get(device.id) === runtime) targetRuntimesRef.current.delete(device.id)
      if (!runtime.stopped) updateTargetStatus(device.id, { signaling: 'disconnected', peerReady: false, connectionState: 'closed', iceConnectionState: 'closed' })
      if (!targetRuntimesRef.current.size) {
        setLiveSessionActive(false)
        if (!runtime.stopped) setLiveSessionStatus('No active target sessions')
      }
    })
  }
  async function startLiveSession() {
    if (!supabase || !selected || selected.type !== 'live' || !selected.content.liveSourceId) return
    const targets = activeDevices.filter(device => !selected.target.length || selected.target.includes(device.id))
    const signalingUrl = import.meta.env.VITE_SIGNALING_URL
    if (!targets.length) return setLiveSessionStatus('Select at least one target screen')
    if (!signalingUrl) return setLiveSessionStatus('Signaling URL is not configured')
    if (cameraLayerId !== selected.id || !cameraStreamRef.current?.getVideoTracks().some(track => track.readyState === 'live')) return setLiveSessionStatus('Enable camera preview for this layer first')
    const { data, error } = await supabase.auth.getSession()
    if (error || !data.session?.access_token) return setLiveSessionStatus('Sign in again to start signaling')
    stopLiveSession()
    const statuses = Object.fromEntries(targets.map(device => [device.id, { deviceId: device.id, name: device.name, signaling: 'connecting' as const, peerReady: false, connectionState: 'idle' as const, iceConnectionState: 'idle' as const }]))
    setTargetStatuses(statuses)
    setLiveSessionActive(true)
    setLiveSessionStatus(`Starting ${targets.length} target${targets.length === 1 ? '' : 's'}`)
    for (const target of targets) startTargetSession(target, selected.content.liveSourceId, data.session.access_token, signalingUrl)
    if (!targetRuntimesRef.current.size) { setLiveSessionActive(false); setLiveSessionStatus('Signaling error') }
  }
  async function startCamera(requestedCameraId = selectedCameraId) {
    if (!selected || selected.type !== 'live') return
    const cameras = await listCameras()
    const cameraId = cameras.some(device => device.deviceId === requestedCameraId) ? requestedCameraId : cameras[0]?.deviceId
    if (!cameraId || !navigator.mediaDevices?.getUserMedia) { if (!cameraId) setCameraError('No video inputs found.'); else setCameraError('Camera preview is unavailable in this browser.'); return }
    setSelectedCameraId(cameraId)
    stopCamera()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cameraId } }, audio: false })
      cameraStreamRef.current = stream
      stream.getVideoTracks().forEach(track => { track.onended = () => { if (cameraStreamRef.current === stream) { cameraStreamRef.current = null; setCameraStream(null); setCameraLayerId(null); if (targetRuntimesRef.current.size) stopLiveSession(); setCameraError('Camera is no longer available.'); void listCameras() } } })
      setCameraStream(stream)
      setCameraLayerId(selected.id)
      setCameraError('')
      void listCameras()
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      setCameraError(name === 'NotAllowedError' ? 'Camera permission was denied.' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'The selected camera is unavailable.' : 'Camera preview could not be started.')
    }
  }
  function updateLayer(id: string, change: Partial<SceneLayer>) { setScene({ ...currentScene, layers: currentScene.layers.map((layer) => layer.id === id ? { ...layer, ...change } : layer) }) }
  function updateContent(key: 'text' | 'url' | 'timezone' | 'fontFamily', value: string) { if (selected) updateLayer(selected.id, { content: { ...selected.content, [key]: value } }) }
  function addLayer(type: 'image' | 'video' | 'live') { const layer: SceneLayer = { id: crypto.randomUUID(), type, target: [], space: 'wall', coordinateSpace: 'freeform', x: 10, y: 10, width: 45, height: 45, zIndex: currentScene.layers.length + 1, scale: 1, rotation: 0, lockedAspect: true, aspectRatio: 16 / 9, content: type === 'live' ? { liveSourceId: crypto.randomUUID() } : { url: '' } }; setScene({ ...currentScene, layers: [...currentScene.layers, layer] }); setSelectedId(layer.id) }
  function removeSelected() { if (!selected) return; if (cameraLayerId === selected.id) stopCamera(); setScene({ ...currentScene, layers: currentScene.layers.filter((layer) => layer.id !== selected.id) }); setSelectedId('') }
  function moveLayer(direction: 'up' | 'down') { if (!selected) return; updateLayer(selected.id, { zIndex: Math.max(1, selected.zIndex + (direction === 'up' ? 1 : -1)) }) }
  function toggleTarget(deviceId: string) { if (!selected) return; const target = !selected.target.length ? devices.filter((item) => item.id !== deviceId).map((item) => item.id) : selected.target.includes(deviceId) ? selected.target.filter((id) => id !== deviceId) : [...selected.target, deviceId]; updateLayer(selected.id, { target }) }
  function toggleSceneDevice(deviceId: string) { const current = currentScene.device_ids ?? []; const next = !current.length ? devices.filter((item) => item.id !== deviceId).map((item) => item.id) : current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId]; setScene({ ...currentScene, device_ids: next.length === devices.length ? [] : next }) }
  function updateDeviceLayout(deviceId: string, change: Partial<Device>) { setDevices((items) => items.map((item) => item.id === deviceId ? { ...item, ...change } : item)); setLayoutDirty(true) }
  async function save() { if (!supabase) return; const { error } = await supabase.from('scenes').update({ name: currentScene.name, layers: currentScene.layers, duration_seconds: currentScene.duration_seconds, device_ids: currentScene.device_ids ?? [] }).eq('id', currentScene.id); setNotice(error ? error.message : 'Scene saved. Publish it from the dashboard when ready.') }
  async function saveLayout() { if (!supabase) return; const client = supabase; const results = await Promise.all(devices.map(({ id, name, layout_x, layout_y, layout_width, layout_height, auto_size }) => client.from('devices').update({ name, layout_x, layout_y, auto_size, ...(auto_size === false ? { layout_width, layout_height } : {}) }).eq('id', id))); const error = results.find((result) => result.error)?.error; if (error) return setNotice(error.message); setLayoutDirty(false); setNotice('Physical screen layout saved.') }
  async function upload(file: File) { if (!supabase || !selected) return; setNotice('Uploading media…'); const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80); const path = `${currentScene.id}/${crypto.randomUUID()}-${safeName}`; const { error } = await supabase.storage.from('media').upload(path, file, { cacheControl: '31536000', upsert: false }); if (error) return setNotice(error.message); const { data } = supabase.storage.from('media').getPublicUrl(path); updateLayer(selected.id, { content: { ...selected.content, url: data.publicUrl } }); setNotice('Uploaded. Save the scene to keep this layer.') }
  function startDrag(event: PointerEvent<HTMLDivElement>, layer: SceneLayer, device?: Device) { if (spaceHeld) return; const box = event.currentTarget.closest('.editor-stage')!.getBoundingClientRect(); const pointX = ((event.clientX - box.left) / box.width) * 100, pointY = ((event.clientY - box.top) / box.height) * 100; const screenLeft = device ? ((device.layout_x ?? 0) / WALL_WORKSPACE_WIDTH) * 100 : 0, screenTop = device ? ((device.layout_y ?? 0) / WALL_WORKSPACE_HEIGHT) * 100 : 0, screenWidth = device ? ((device.layout_width ?? 1) / WALL_WORKSPACE_WIDTH) * 100 : 100, screenHeight = device ? ((device.layout_height ?? 1) / WALL_WORKSPACE_HEIGHT) * 100 : 100; setSelectedId(layer.id); setDrag({ id: layer.id, deviceId: device?.id, offsetX: (pointX - screenLeft) / screenWidth * 100 - layer.x, offsetY: (pointY - screenTop) / screenHeight * 100 - layer.y }); event.currentTarget.setPointerCapture(event.pointerId) }
  function dragLayer(event: PointerEvent<HTMLDivElement>) { if (!drag) return; const box = event.currentTarget.getBoundingClientRect(), device = devices.find((item) => item.id === drag.deviceId), pointX = ((event.clientX - box.left) / box.width) * 100, pointY = ((event.clientY - box.top) / box.height) * 100; const left = device ? ((device.layout_x ?? 0) / WALL_WORKSPACE_WIDTH) * 100 : 0, top = device ? ((device.layout_y ?? 0) / WALL_WORKSPACE_HEIGHT) * 100 : 0, width = device ? ((device.layout_width ?? 1) / WALL_WORKSPACE_WIDTH) * 100 : 100, height = device ? ((device.layout_height ?? 1) / WALL_WORKSPACE_HEIGHT) * 100 : 100; updateLayer(drag.id, { x: (pointX - left) / width * 100 - drag.offsetX, y: (pointY - top) / height * 100 - drag.offsetY }) }
  function startDeviceDrag(event: PointerEvent<HTMLSpanElement>, device: Device) { if (spaceHeld) return; const box = event.currentTarget.parentElement!.parentElement!.getBoundingClientRect(); setDeviceDrag({ id: device.id, offsetX: ((event.clientX - box.left) / box.width) * WALL_WORKSPACE_WIDTH - (device.layout_x ?? 0), offsetY: ((event.clientY - box.top) / box.height) * WALL_WORKSPACE_HEIGHT - (device.layout_y ?? 0) }); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation() }
  function dragDevice(event: PointerEvent<HTMLDivElement>) { if (!deviceDrag) return; const box = event.currentTarget.getBoundingClientRect(); updateDeviceLayout(deviceDrag.id, { layout_x: ((event.clientX - box.left) / box.width) * WALL_WORKSPACE_WIDTH - deviceDrag.offsetX, layout_y: ((event.clientY - box.top) / box.height) * WALL_WORKSPACE_HEIGHT - deviceDrag.offsetY }) }
  function startPan(event: PointerEvent<HTMLDivElement>) { if (event.button !== 1 && !spaceHeld) return; setPanDrag({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }
  function movePan(event: PointerEvent<HTMLDivElement>) { if (panDrag) setPan({ x: panDrag.panX + event.clientX - panDrag.x, y: panDrag.panY + event.clientY - panDrag.y }) }
  function zoomCanvas(event: WheelEvent<HTMLElement>) { event.preventDefault(); const nextZoom = Math.max(.2, Math.min(128, Number((zoom * (event.deltaY < 0 ? 1.18 : .85)).toFixed(3)))), stage = stageRef.current; if (stage && nextZoom !== zoom) setPan(current => panForCursorZoom({ pan: current, zoom, nextZoom, stage: stage.getBoundingClientRect(), cursor: { x: event.clientX, y: event.clientY } })); setZoom(nextZoom) }
  function fitScreens() { const stage = stageRef.current, workspace = stageRef.current?.parentElement; if (!stage || !workspace || !activeDevices.length) return; const controls = workspace.querySelector<HTMLElement>('.canvas-controls'), hint = workspace.querySelector<HTMLElement>('.canvas-hint'); const view = fitEditorView({ bounds: bounds(activeDevices.map(deviceRect)), workspace: { width: workspace.clientWidth, height: workspace.clientHeight - (controls?.offsetHeight ?? 0) - (hint?.offsetHeight ?? 0) }, stage: { width: stage.clientWidth, height: stage.clientHeight }, wall: { width: WALL_WORKSPACE_WIDTH, height: WALL_WORKSPACE_HEIGHT } }); if (!view) return; setZoom(view.zoom); setPan(view.pan) }
  function setMediaSize(layerId: string, sourceWidth: number, sourceHeight: number) { if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return; const layer = currentScene.layers.find((item) => item.id === layerId); if (!layer || (layer.sourceWidth === sourceWidth && layer.sourceHeight === sourceHeight)) return; const target = devices.find((item) => isSceneDevice(item.id) && (!layer.target.length || layer.target.includes(item.id))), screenSpace = (layer.space ?? 'screen') === 'screen', referenceWidth = screenSpace ? target?.layout_width ?? 1920 : WALL_WORKSPACE_WIDTH, referenceHeight = screenSpace ? target?.layout_height ?? 1080 : WALL_WORKSPACE_HEIGHT; updateLayer(layerId, { sourceWidth, sourceHeight, aspectRatio: sourceWidth / sourceHeight, width: sourceWidth / referenceWidth * 100, height: sourceHeight / referenceHeight * 100 }) }
  function updateDimension(key: 'width' | 'height', value: number) { if (!selected) return; const change: Partial<SceneLayer> = { [key]: value }; if (selected.lockedAspect && selected.aspectRatio) { const target = activeDevices.find(item => !selected.target.length || selected.target.includes(item.id)), reference = layerReference(selected, currentScene, devices, target); if (key === 'width') change.height = value * (reference.width / reference.height) / selected.aspectRatio; else change.width = value * selected.aspectRatio / (reference.width / reference.height) }; updateLayer(selected.id, change) }
  const editorMedia = (layer: SceneLayer) => <EditorMedia layer={layer} liveStream={cameraStream} liveLayerId={cameraLayerId} onSize={(width, height) => setMediaSize(layer.id, width, height)} />
  const rectStyle = (item: Device) => ({ left: `${((item.layout_x ?? 0) / WALL_WORKSPACE_WIDTH) * 100}%`, top: `${((item.layout_y ?? 0) / WALL_WORKSPACE_HEIGHT) * 100}%`, width: `${((item.layout_width ?? 1) / WALL_WORKSPACE_WIDTH) * 100}%`, height: `${((item.layout_height ?? 1) / WALL_WORKSPACE_HEIGHT) * 100}%` })
  return <main className="editor-page"><header className="editor-header"><a href="/">← Dashboard</a><div><input aria-label="Scene name" value={currentScene.name} onChange={(event) => setScene({ ...currentScene, name: event.target.value })} /><p>Scene editor</p></div><div className="editor-actions"><button className="secondary" disabled={!layoutDirty} onClick={() => void saveLayout()}>Save screen layout</button><button onClick={() => void save()}>Save scene</button></div></header><div className="editor-layout">
    <aside className="editor-toolbar">
      <section className="editor-sidebar-group">
        <div className="editor-sidebar-heading"><p className="eyebrow">SCREENS IN THIS SCENE</p><span>{activeDevices.length} / {devices.length}</span></div>
        <div className="screen-list"><small>Choose displays, then place their lit image areas. Left/Top include bezels and gaps. Save screen layout to apply changes to the players.</small>{devices.map((item) => <details className="screen-list-item" key={item.id}><summary><input aria-label={`Use ${item.name} in this scene`} type="checkbox" checked={isSceneDevice(item.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSceneDevice(item.id)} /><span>{item.name}</span></summary><div className="screen-details-body"><label>Name<input value={item.name} onChange={(event) => updateDeviceLayout(item.id, { name: event.target.value })} /></label><ScreenLayoutControls device={item} onChange={change => updateDeviceLayout(item.id, change)} /></div></details>)}</div>
        {activeDevices.some(d => d.auto_size === false) && activeDevices.some(d => d.auto_size !== false) && <p className="notice">Mixed layout units: enter measured sizes for every selected screen before aligning them.</p>}
        <small>Screen outlines stay above media. Drag a screen label to position that display independently.</small>
      </section>
      <section className="editor-sidebar-group">
        <p className="eyebrow">ADD MEDIA</p>
        <div className="editor-add-actions"><button onClick={() => addLayer('image')}>▣ Image</button><button onClick={() => addLayer('video')}>▶ Video</button><button onClick={() => addLayer('live')}>● Live input</button></div>
      </section>
      <section className="editor-sidebar-group">
        <div className="editor-sidebar-heading"><p className="eyebrow">LAYERS</p><span>{currentScene.layers.length}</span></div>
        <div className="editor-layer-list">
          {layersByStack.length ? layersByStack.map(({ layer }) => <button key={layer.id} type="button" className={`editor-layer-row ${layer.id === selectedId ? 'is-selected' : ''}`} aria-pressed={layer.id === selectedId} onClick={() => setSelectedId(layer.id)} title={layerLabel(layer)}><span className="editor-layer-type">{layer.type}</span><span className="editor-layer-name">{layerLabel(layer)}</span></button>) : <small>No layers yet. Add an image or video above.</small>}
        </div>
      </section>
      {selected && <section className="editor-sidebar-group editor-layer-settings"><p className="eyebrow">LAYER DISPLAY</p><div className="wall-layer-controls"><label>Layer canvas<select value={selected.space ?? 'screen'} onChange={(event) => updateLayer(selected.id, { space: event.target.value as 'screen' | 'wall' })}><option value="screen">One copy on each selected display</option><option value="wall">Full wall — span and crop across displays</option></select></label><div className="target-picker"><span>This layer appears on</span>{devices.map((item) => <label key={item.id} className={!isSceneDevice(item.id) ? 'disabled-target' : ''}><input type="checkbox" disabled={!isSceneDevice(item.id)} checked={isSceneDevice(item.id) && (!selected.target.length || selected.target.includes(item.id))} onChange={() => toggleTarget(item.id)} /> {item.name}</label>)}</div></div></section>}
    </aside>
    <section className="editor-stage-wrap" onWheel={zoomCanvas}><div className="canvas-controls"><button className="secondary" onClick={() => setZoom((current) => Math.max(.2, current - .2))}>−</button><span>{Math.round(zoom * 100)}%</span><button className="secondary" onClick={() => setZoom((current) => Math.min(128, current + .2))}>+</button><button className="secondary" onClick={fitScreens}>Fit screens</button><button className="secondary" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>Reset</button></div><div ref={stageRef} className={`editor-stage media-workspace ${spaceHeld || panDrag ? 'panning-workspace' : ''}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, '--guide-inset': `${(1 - zoom) * 50}%`, '--guide-size': `${zoom * 100}%`, '--guide-scale': 1 / zoom } as CSSProperties} onPointerDown={startPan} onPointerMove={(event) => { movePan(event); dragLayer(event); dragDevice(event) }} onPointerUp={() => { setDrag(null); setDeviceDrag(null); setPanDrag(null) }} onPointerCancel={() => { setDrag(null); setDeviceDrag(null); setPanDrag(null) }}>{currentScene.layers.map((layer) => (layer.space ?? 'screen') === 'screen' ? devices.filter((item) => isSceneDevice(item.id) && (!layer.target.length || layer.target.includes(item.id))).map((item) => <div className="screen-layer-clip" key={`${layer.id}-${item.id}`} style={{ ...rectStyle(item), zIndex: layer.zIndex }}><div className={`canvas-layer ${layer.id === selectedId ? 'selected-layer' : ''}`} style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` }} onPointerDown={(event) => startDrag(event, layer, item)}>{editorMedia(layer)}</div></div>) : <div key={layer.id} className={`canvas-layer ${layer.id === selectedId ? 'selected-layer' : ''}`} style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, zIndex: layer.zIndex, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` }} onPointerDown={(event) => startDrag(event, layer)}>{editorMedia(layer)}</div>)}{devices.map((item) => <div className={`device-mask ${isSceneDevice(item.id) ? '' : 'inactive-device'}`} key={item.id} style={rectStyle(item)}><span style={{ transform: `scale(${1 / zoom})` }} onPointerDown={(event) => startDeviceDrag(event, item)}>{item.name}</span></div>)}</div><p className="canvas-hint">Scroll to zoom · hold Space and drag, or use middle mouse, to pan.</p></section>
    <aside className="inspector">
      <p className="eyebrow">{selected ? 'MEDIA LAYER' : 'INSPECTOR'}</p>
      {selected ? <>
        <section className="inspector-section" aria-label="Source">
          <h2>Source</h2>
          <label>Type<select value={selected.type} disabled={selected.type === 'live'} onChange={(event) => updateLayer(selected.id, { type: event.target.value as 'image' | 'video' })}><option value="image">Image</option><option value="video">Video</option>{selected.type === 'live' && <option value="live">Live input</option>}</select></label>
          {selected.type === 'live' ? <><p>Live source: {selected.content.liveSourceId || 'Not assigned'}. This preview stays in this browser.</p><div className="live-camera-controls"><button className="secondary" onClick={() => void listCameras()}>Find cameras</button>{cameraDevices.length > 0 && <label>Camera<select value={selectedCameraId} onChange={(event) => { const nextCameraId = event.target.value; setSelectedCameraId(nextCameraId); if (cameraStream && cameraLayerId === selected.id) void startCamera(nextCameraId) }}>{cameraDevices.map((camera, index) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}</select></label>}<button onClick={() => void startCamera()}>{cameraStream && cameraLayerId === selected.id ? 'Restart preview' : 'Enable preview'}</button>{cameraStream && cameraLayerId === selected.id && <button className="secondary" onClick={stopCamera}>Disable preview</button>}</div>{cameraError && <p className="live-camera-message">{cameraError}</p>}<div className="live-camera-controls"><span>{selectedLiveTargets.length} target{selectedLiveTargets.length === 1 ? '' : 's'} from layer targeting</span><button disabled={!selectedLiveTargets.length} onClick={() => void startLiveSession()}>Start live session</button>{liveSessionActive && <button className="secondary" onClick={() => stopLiveSession()}>End session</button>}</div><small>To change targets while streaming: end the session, save the layer targeting, then start again.</small><p className="live-camera-message">{liveSessionActive ? `${connectedTargetCount}/${Object.keys(targetStatuses).length} targets WebRTC connected` : liveSessionStatus}</p>{Object.values(targetStatuses).map(status => <p className="live-camera-message" key={status.deviceId}><strong>{status.name}</strong> — signaling {status.signaling} · ready {status.peerReady ? 'yes' : 'no'} · WebRTC {status.connectionState} · ICE {status.iceConnectionState}</p>)}</> : <><label>Media URL<input type="url" value={selected.content.url ?? ''} onChange={(event) => updateContent('url', event.target.value)} placeholder="https://…" /></label><label className="upload-button">Upload {selected.type}<input type="file" accept={selected.type === 'video' ? 'video/*' : 'image/*'} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file) }} /></label></>}
        </section>
        <section className="inspector-section" aria-label="Fit and display">
          <h2>Fit / Display</h2>
          {selected.type !== 'live' && <label>Image fit<select value={selected.content.fit ?? 'cover'} onChange={event => updateLayer(selected.id, { content: { ...selected.content, fit: event.target.value as 'cover' | 'contain' } })}><option value="cover">Fill layer (crop edges)</option><option value="contain">Show whole image</option></select></label>}
          <label><input type="checkbox" checked={selected.lockedAspect !== false} onChange={(event) => updateLayer(selected.id, { lockedAspect: event.target.checked })} /> Lock media aspect ratio</label>
          <button className="secondary" disabled={!activeDevices.length} onClick={() => updateLayer(selected.id, fitLayerToDevices(selected, activeDevices))}>Fit layer to selected screens</button>
        </section>
        <section className="inspector-section" aria-label="Transform">
          <h2>Transform</h2>
          <div className="position-grid"><label>x<input type="number" value={selected.x} onChange={(event) => updateLayer(selected.id, { x: Number(event.target.value) })} /></label><label>y<input type="number" value={selected.y} onChange={(event) => updateLayer(selected.id, { y: Number(event.target.value) })} /></label><label>width<input type="number" min="0" value={selected.width} onChange={(event) => updateDimension('width', Number(event.target.value))} /></label><label>height<input type="number" min="0" value={selected.height} onChange={(event) => updateDimension('height', Number(event.target.value))} /></label></div>
          <div className="position-grid"><label>Rotation (degrees)<input type="number" value={selected.rotation ?? 0} onChange={(event) => updateLayer(selected.id, { rotation: Number(event.target.value) })} /></label><label>Scale<input type="number" min="0.1" max="5" step="0.01" value={selected.scale ?? 1} onChange={(event) => updateLayer(selected.id, { scale: Math.max(.1, Number(event.target.value)) })} /></label></div>
        </section>
        <section className="inspector-section" aria-label="Layer">
          <h2>Layer</h2>
          <div className="stack-controls"><button className="secondary" onClick={() => moveLayer('up')}>Bring forward</button><button className="secondary" onClick={() => moveLayer('down')}>Send backward</button></div>
          <button className="danger" onClick={removeSelected}>Remove layer</button>
        </section>
      </> : <p>Select an image or video layer to edit it.</p>}
    </aside>
  </div>{notice && <p className="editor-notice">{notice}</p>}</main>
}
