import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react'
import { ScreenLayoutControls } from '../ScreenLayoutControls'
import { advanceWorkspaceDrag, deltaClientToWorkspace, devicePositionChange, displayedZoomPercent, fitEditorView, nudgeDevicePosition, stageGeometryFromRect, startWorkspaceDrag, workspaceRectToClientRect, zoomAroundCursor, zoomFromWheel, type ClientRect, type DeviceNudgeKey, type EditorView, type Point, type StageGeometry, type WorkspaceDrag, type WorkspaceRect } from '../lib/editorZoom'
import { supabase } from '../lib/supabase'
import { addOrQueueIceCandidate, flushIceCandidates, webRtcConfiguration, type PendingIceCandidate } from '../lib/webrtc'
import { recoveryDelayMs } from '../lib/recovery'
import { WALL_WORKSPACE_HEIGHT, WALL_WORKSPACE_WIDTH, bounds, deviceRect, fitLayerToDevices, newImageLayerSize, sceneDevices, toWorkspaceLayer } from '../lib/wallGeometry'
import type { Device, Scene, SceneLayer } from '../types'
import { parseServerSignalingMessage, scopedClientMessage, SIGNALING_VERSION, type AuthenticatedMessage } from '../signalingProtocol'
import { MediaLibrary } from '../media/MediaLibrary'
import { uploadMediaAsset } from '../media/mediaApi'
import { layerPlaybackUrl, layerWithMediaAsset, mediaDimensionChange, mediaTypeForMime } from '../media/mediaLibraryUtils'
import type { MediaAsset, Wall } from '../types'
import { editorLayerRect, editorSceneCanvas, editorSceneSaveValues, editorVirtualDeviceRects, fitVirtualLayerToRegions, moveEditorLayer, newEditorLayer, v2CurrentWallContract, v2WallGeometryWarning, virtualGeometryForWall } from '../lib/editorSceneGeometry'

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
  const url = layerPlaybackUrl(layer)
  return layer.type === 'image' && url ? <img style={{ objectFit: layer.content.fit ?? 'cover' }} src={url} alt="" onLoad={event => onSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /> : layer.type === 'video' && url ? <video className="editor-video" style={{ objectFit: layer.content.fit ?? 'cover' }} src={url} autoPlay muted loop playsInline onLoadedMetadata={event => onSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} /> : <div className="media-placeholder">{layer.type === 'video' ? '▶ Video source' : '▣ Image source'}</div>
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

const WEBRTC_DISCONNECT_GRACE_MS = 5000
type TargetSignalingState = 'connecting' | 'waiting' | 'connected' | 'recovering' | 'disconnected' | 'error' | 'ended'
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
  socket: WebSocket | null
  scope: AuthenticatedMessage | null
  peer: RTCPeerConnection | null
  pendingIceCandidates: PendingIceCandidate[]
  stopped: boolean
  accessToken: string
  signalingUrl: string
  liveSourceId: string
  retryAttempt: number
  retryTimer: number | null
  disconnectGraceTimer: number | null
}

type DragMotion = { id: string; deviceId?: string; x: number; y: number; lastClient: Point }
type DeviceDrag = { id: string; pointerId: number; origin: WorkspaceDrag }

export function SceneEditorPage({ sceneId }: { sceneId: string }) {
  const [scene, setScene] = useState<Scene | null>(null)
  const [sceneWall, setSceneWall] = useState<Wall | null>(null)
  const [sceneWallLoaded, setSceneWallLoaded] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false)
  const newMediaLayerIdsRef = useRef(new Set<string>())
  const dragRef = useRef<DragMotion | null>(null)
  const deviceDragRef = useRef<DeviceDrag | null>(null)
  const [layoutDirty, setLayoutDirty] = useState(false)
  const [devicesLoaded, setDevicesLoaded] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [overlayStage, setOverlayStage] = useState<StageGeometry | null>(null)
  const initialFitSceneRef = useRef<string | null>(null)
  const [view, setView] = useState<EditorView>({ zoom: 1, pan: { x: 0, y: 0 } })
  const [fitZoom, setFitZoom] = useState(1)
  const { zoom, pan } = view
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
  useEffect(() => { if (!supabase) return; void supabase.from('scenes').select('id,name,layers,duration_seconds,device_ids,wall_id,geometry_version,canvas_width_px,canvas_height_px,wall_geometry_revision').eq('id', sceneId).single().then(({ data, error }) => { if (error) return setNotice(error.message); const loaded = { ...data, layers: data.layers as SceneLayer[] }; setScene(loaded); setSelectedId(loaded.layers[0]?.id ?? '') }) }, [sceneId])
  useEffect(() => {
    let cancelled = false
    setSceneWallLoaded(false)
    if (!scene?.wall_id || !supabase) { setSceneWall(null); setSceneWallLoaded(true); return }
    void supabase.from('walls').select('id,name,layout_mode,virtual_pixels_per_mm').eq('id', scene.wall_id).single().then(({ data, error }) => {
      if (cancelled) return
      setSceneWall(data ?? null)
      setSceneWallLoaded(true)
      if (error) setNotice(error.message)
    })
    return () => { cancelled = true }
  }, [scene?.wall_id])
  useEffect(() => {
    let cancelled = false
    if (supabase) void supabase.from('devices').select('id,name,wall_id,last_seen_at,width,height,layout_x,layout_y,layout_width,layout_height,auto_size,included_in_wall').order('layout_y').order('layout_x').then(({ data, error }) => {
      if (cancelled) return
      if (error) { setNotice(error.message); return }
      setDevices(data ?? [])
      setDevicesLoaded(true)
    })
    return () => { cancelled = true }
  }, [])
  useEffect(() => { const keyDown = (event: KeyboardEvent) => { if (event.code === 'Space' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); setSpaceHeld(true) } }; const keyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false) }; window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); return () => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp) } }, [])
  useEffect(() => {
    const nudge = (event: KeyboardEvent) => {
      if (scene?.geometry_version === 2) return
      if (!selectedDeviceId || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      event.preventDefault()
      setDevices(items => items.map(item => {
        if (item.id !== selectedDeviceId) return item
        const position = nudgeDevicePosition({ x: item.layout_x ?? 0, y: item.layout_y ?? 0 }, event.key as DeviceNudgeKey, event.shiftKey)
        return { ...item, ...devicePositionChange(position) }
      }))
      setLayoutDirty(true)
    }
    window.addEventListener('keydown', nudge)
    return () => window.removeEventListener('keydown', nudge)
  }, [selectedDeviceId, scene?.geometry_version])
  useEffect(() => {
    const stage = stageRef.current
    const workspace = stage?.parentElement
    if (!stage || !workspace) return
    const measure = () => {
      const next = {
        center: { x: stage.offsetLeft + stage.offsetWidth / 2, y: stage.offsetTop + stage.offsetHeight / 2 },
        width: stage.offsetWidth,
        height: stage.offsetHeight,
      }
      setOverlayStage(previous => previous
        && previous.center.x === next.center.x && previous.center.y === next.center.y
        && previous.width === next.width && previous.height === next.height
        ? previous : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    observer.observe(stage)
    measure()
    return () => observer.disconnect()
  }, [scene?.id, devicesLoaded])
  useEffect(() => () => { cameraStreamRef.current?.getTracks().forEach(track => track.stop()) }, [])
  useEffect(() => () => stopLiveSession(false), [])
  useEffect(() => {
    if (!scene || !devicesLoaded || initialFitSceneRef.current === scene.id) return
    const workspace = stageRef.current?.parentElement
    const canvas = editorSceneCanvas(scene)
    const active = sceneDevices(scene, devices)
    if (!workspace || !canvas || (scene.geometry_version !== 2 && !active.length)) { if (!active.length || !canvas) initialFitSceneRef.current = scene.id; return }
    const fitInitialView = () => {
      const stage = stageRef.current
      if (!stage) return
      const controls = workspace.querySelector<HTMLElement>('.canvas-controls')
      const hint = workspace.querySelector<HTMLElement>('.canvas-hint')
      const fitted = fitEditorView({ bounds: scene.geometry_version === 2 ? { x: 0, y: 0, ...canvas } : bounds(active.map(deviceRect)), workspace: { width: workspace.clientWidth, height: workspace.clientHeight - (controls?.offsetHeight ?? 0) - (hint?.offsetHeight ?? 0) }, stage: { width: stage.clientWidth, height: stage.clientHeight }, wall: canvas })
      if (!fitted) return
      setView(fitted)
      setFitZoom(fitted.zoom)
      initialFitSceneRef.current = scene.id
      observer.disconnect()
    }
    const observer = new ResizeObserver(fitInitialView)
    observer.observe(workspace)
    fitInitialView()
    return () => observer.disconnect()
  }, [scene, devices, devicesLoaded])
  if (!scene || !devicesLoaded || (scene.geometry_version === 2 && !sceneWallLoaded)) return <main className="player-message">{notice || 'Loading scene editor…'}</main>
  const isV2 = scene.geometry_version === 2
  const resolvedWallSize = editorSceneCanvas(scene)
  if (!resolvedWallSize) return <main className="player-message">V2 scene canvas is invalid.</main>
  const wallSize = resolvedWallSize
  const currentScene = isV2 ? scene : { ...scene, layers: scene.layers.map(layer => toWorkspaceLayer(layer, scene, devices)) }
  const editorDevices = isV2 ? devices.filter(device => device.wall_id === currentScene.wall_id && (sceneWall?.layout_mode !== 'physical' || device.included_in_wall !== false)) : devices
  const virtualGeometry = isV2 ? virtualGeometryForWall(sceneWall, editorDevices) : null
  const virtualDeviceRects = editorVirtualDeviceRects(currentScene, virtualGeometry)
  const activeDevices = sceneDevices(currentScene, editorDevices)
  const activeVirtualDeviceRects = virtualDeviceRects.filter(rect => activeDevices.some(device => device.id === rect.deviceId))
  const revisionWarning = v2WallGeometryWarning(currentScene, virtualGeometry)
  const wallContract = v2CurrentWallContract(currentScene, sceneWall, virtualGeometry)
  const hasRevisionMismatch = isV2 && virtualGeometry?.status === 'valid' && currentScene.wall_geometry_revision !== virtualGeometry.geometryRevision
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
    if (runtime.disconnectGraceTimer !== null) { window.clearTimeout(runtime.disconnectGraceTimer); runtime.disconnectGraceTimer = null }
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
    if (runtime.socket?.readyState !== WebSocket.OPEN || !runtime.scope) throw new Error('Signaling session is unavailable')
    runtime.socket.send(JSON.stringify(scopedClientMessage(runtime.scope, type, payload)))
  }
  async function startEditorPeerConnection(runtime: TargetRuntime) {
    const scope = runtime.scope
    const stream = cameraStreamRef.current
    const videoTracks = stream?.getVideoTracks().filter(track => track.readyState === 'live') ?? []
    if (!scope || !stream || !videoTracks.length) { updateTargetStatus(runtime.device.id, { connectionState: 'failed', signaling: 'recovering' }); return }
    const current = runtime.peer
    if (current && (current.connectionState === 'connected' || current.connectionState === 'connecting')) return
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
      if (peer.connectionState === 'connected') {
        runtime.retryAttempt = 0
        if (runtime.disconnectGraceTimer !== null) { window.clearTimeout(runtime.disconnectGraceTimer); runtime.disconnectGraceTimer = null }
      } else if (peer.connectionState === 'disconnected' && runtime.disconnectGraceTimer === null) {
        updateTargetStatus(runtime.device.id, { signaling: 'recovering' })
        runtime.disconnectGraceTimer = window.setTimeout(() => {
          runtime.disconnectGraceTimer = null
          if (runtime.peer !== peer || peer.connectionState !== 'disconnected') return
          closeTargetPeer(runtime)
          updateTargetStatus(runtime.device.id, { signaling: 'recovering', peerReady: false, connectionState: 'idle', iceConnectionState: 'idle' })
        }, WEBRTC_DISCONNECT_GRACE_MS)
      } else if (peer.connectionState === 'failed') {
        closeTargetPeer(runtime)
        updateTargetStatus(runtime.device.id, { signaling: 'recovering', peerReady: false, connectionState: 'idle', iceConnectionState: 'idle' })
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
    if (runtime.retryTimer !== null) window.clearTimeout(runtime.retryTimer)
    if (notifyPeer && runtime.scope && runtime.socket?.readyState === WebSocket.OPEN) {
      try { runtime.socket.send(JSON.stringify(scopedClientMessage(runtime.scope, 'session-ended', { reason: 'controller-stopped' }))) } catch { /* socket cleanup continues */ }
    }
    closeTargetPeer(runtime)
    try { runtime.socket?.close(1000, 'controller-stopped') } catch { /* socket may still be connecting */ }
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
    const runtime: TargetRuntime = { device, socket: null, scope: null, peer: null, pendingIceCandidates: [], stopped: false, accessToken, signalingUrl, liveSourceId, retryAttempt: 0, retryTimer: null, disconnectGraceTimer: null }
    targetRuntimesRef.current.set(device.id, runtime)
    const scheduleReconnect = () => {
      if (runtime.stopped || runtime.retryTimer !== null) return
      const delay = recoveryDelayMs(runtime.retryAttempt++)
      runtime.retryTimer = window.setTimeout(() => { runtime.retryTimer = null; connect() }, delay)
    }
    const connect = () => {
      if (runtime.stopped || runtime.socket?.readyState === WebSocket.OPEN || runtime.socket?.readyState === WebSocket.CONNECTING) return
      let socket: WebSocket
      updateTargetStatus(device.id, { signaling: runtime.scope ? 'recovering' : 'connecting' })
      try { socket = new WebSocket(runtime.signalingUrl) } catch { scheduleReconnect(); return }
      runtime.socket = socket
      socket.addEventListener('open', () => {
        if (runtime.stopped || runtime.socket !== socket) return
        socket.send(JSON.stringify({ version: SIGNALING_VERSION, type: 'auth', role: 'editor', accessToken: runtime.accessToken, wallId: device.wall_id, targetDeviceId: device.id, liveSourceId: runtime.liveSourceId, ...(runtime.scope ? { sessionId: runtime.scope.sessionId } : {}) }))
      })
    socket.addEventListener('message', event => { void (async () => {
        if (typeof event.data !== 'string' || runtime.stopped || runtime.socket !== socket) return
      const message = parseServerSignalingMessage(event.data)
      if (!message) return updateTargetStatus(device.id, { signaling: 'error' })
        if (message.type === 'authenticated' && message.role === 'editor') {
          if (runtime.scope && message.sessionId !== runtime.scope.sessionId) return
          runtime.scope = message
          runtime.retryAttempt = 0
          updateTargetStatus(device.id, { signaling: 'waiting' })
      } else if (message.type === 'peer-ready') {
        if (!runtime.scope || message.sessionId !== runtime.scope.sessionId || message.generation !== runtime.scope.generation) return
        updateTargetStatus(device.id, { signaling: 'connected', peerReady: true })
        await startEditorPeerConnection(runtime)
      } else if (message.type === 'answer') {
        if (!runtime.peer || message.generation !== runtime.scope?.generation || message.sessionId !== runtime.scope?.sessionId) return
        await runtime.peer.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp })
        await flushIceCandidates(runtime.peer, runtime.pendingIceCandidates)
      } else if (message.type === 'ice-candidate') {
        if (!runtime.scope || message.sessionId !== runtime.scope.sessionId || message.generation !== runtime.scope.generation) return
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
        updateTargetStatus(device.id, { signaling: 'recovering' })
        scheduleReconnect()
      }
    })().catch(() => { updateTargetStatus(device.id, { signaling: 'recovering', connectionState: 'failed' }); scheduleReconnect() }) })
      socket.addEventListener('error', () => { if (runtime.socket === socket) updateTargetStatus(device.id, { signaling: 'recovering' }) })
      socket.addEventListener('close', () => {
        if (runtime.socket !== socket) return
        runtime.socket = null
        if (!runtime.stopped) { updateTargetStatus(device.id, { signaling: 'recovering' }); scheduleReconnect() }
      })
    }
    connect()
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
  function updateLayer(id: string, change: Partial<SceneLayer>) {
    if ((isV2 && (change.x !== undefined || change.y !== undefined)) || change.width !== undefined || change.height !== undefined || change.type !== undefined) newMediaLayerIdsRef.current.delete(id)
    setScene({ ...currentScene, layers: currentScene.layers.map((layer) => layer.id === id ? { ...layer, ...change } : layer) })
  }
  function updateContent(key: 'text' | 'url' | 'timezone' | 'fontFamily', value: string) { if (selected) { if (key === 'url') newMediaLayerIdsRef.current.delete(selected.id); updateLayer(selected.id, { content: { ...selected.content, ...(key === 'url' ? { mediaAssetId: undefined } : {}), [key]: value } }) } }
  function addLayer(type: 'image' | 'video' | 'live') {
    const id = crypto.randomUUID()
    const imageSize = newImageLayerSize(activeDevices.length ? bounds(activeDevices.map(deviceRect)) : undefined)
    const layer: SceneLayer = isV2
      ? newEditorLayer(currentScene, type, id, currentScene.layers.length + 1, type === 'live' ? crypto.randomUUID() : undefined)
      : { id, type, target: [], space: 'wall', coordinateSpace: 'freeform', x: 10, y: 10, width: type === 'image' ? imageSize.width : 45, height: type === 'image' ? imageSize.height : 45, zIndex: currentScene.layers.length + 1, scale: 1, rotation: 0, lockedAspect: true, aspectRatio: 16 / 9, content: type === 'live' ? { liveSourceId: crypto.randomUUID() } : { url: '' } }
    if (type !== 'live') newMediaLayerIdsRef.current.add(layer.id)
    setScene({ ...currentScene, layers: [...currentScene.layers, layer] })
    setSelectedId(layer.id)
  }
  function removeSelected() { if (!selected) return; newMediaLayerIdsRef.current.delete(selected.id); if (cameraLayerId === selected.id) stopCamera(); setScene({ ...currentScene, layers: currentScene.layers.filter((layer) => layer.id !== selected.id) }); setSelectedId('') }
  function moveLayer(direction: 'up' | 'down') { if (!selected) return; updateLayer(selected.id, { zIndex: Math.max(1, selected.zIndex + (direction === 'up' ? 1 : -1)) }) }
  function toggleTarget(deviceId: string) { if (!selected) return; const target = !selected.target.length ? editorDevices.filter((item) => item.id !== deviceId).map((item) => item.id) : selected.target.includes(deviceId) ? selected.target.filter((id) => id !== deviceId) : [...selected.target, deviceId]; updateLayer(selected.id, { target }) }
  function toggleSceneDevice(deviceId: string) { const current = currentScene.device_ids ?? []; const next = !current.length ? editorDevices.filter((item) => item.id !== deviceId).map((item) => item.id) : current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId]; setScene({ ...currentScene, device_ids: next.length === editorDevices.length ? [] : next }) }
  function updateDeviceLayout(deviceId: string, change: Partial<Device>) { if (isV2) return; setDevices((items) => items.map((item) => item.id === deviceId ? { ...item, ...change } : item)); setLayoutDirty(true) }
  async function save() { if (!supabase) return; const { error } = await supabase.from('scenes').update(editorSceneSaveValues(currentScene)).eq('id', currentScene.id); setNotice(error ? error.message : 'Scene saved. Publish it from the dashboard when ready.') }
  async function updateToCurrentWallLayout() {
    if (!supabase || !hasRevisionMismatch || wallContract.status !== 'valid') return
    if (!confirm('The physical wall layout changed. Updating adopts the new screen positions and canvas size. Layer positions and sizes will not be changed.')) return
    const { error } = await supabase.from('scenes').update(wallContract.values).eq('id', currentScene.id)
    if (error) return setNotice(error.message)
    setScene(current => current ? { ...current, ...wallContract.values } : current)
    setNotice('Scene updated to the current wall layout. Layer positions and sizes were not changed.')
  }
  async function saveLayout() { if (!supabase) return; const client = supabase; const results = await Promise.all(devices.map(({ id, name, layout_x, layout_y, layout_width, layout_height, auto_size }) => client.from('devices').update({ name, layout_x, layout_y, auto_size, ...(auto_size === false ? { layout_width, layout_height } : {}) }).eq('id', id))); const error = results.find((result) => result.error)?.error; if (error) return setNotice(error.message); setLayoutDirty(false); setNotice('Physical screen layout saved.') }
  function selectMediaAsset(asset: MediaAsset) {
    if (!selected || (selected.type !== 'image' && selected.type !== 'video')) return
    try {
      const isNewMediaLayer = newMediaLayerIdsRef.current.delete(selected.id)
      const initialSizing = isNewMediaLayer ? (isV2 ? 'intrinsic' : 'match-aspect') : 'preserve'
      updateLayer(selected.id, layerWithMediaAsset(selected, asset, initialSizing))
      setMediaPickerOpen(false)
      setNotice(`${asset.name} selected. Save the scene to keep this layer.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Media selection failed.') }
  }
  async function uploadNewMedia(file: File) {
    if (!selected || (selected.type !== 'image' && selected.type !== 'video')) return
    if (mediaTypeForMime(file.type) !== selected.type) { setNotice(`Choose a ${selected.type} file for this ${selected.type} layer.`); return }
    setNotice(`Uploading ${file.name}…`)
    try { selectMediaAsset(await uploadMediaAsset(file)) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Media upload failed.') }
  }
  function stageGeometry() {
    const stage = stageRef.current
    return stage ? stageGeometryFromRect(stage.getBoundingClientRect(), view) : null
  }
  function dragDelta(event: PointerEvent<HTMLDivElement>, motion: DragMotion) {
    const geometry = stageGeometry()
    if (!geometry) return null
    const sensitivity = event.shiftKey ? .1 : 1
    const delta = deltaClientToWorkspace({ x: (event.clientX - motion.lastClient.x) * sensitivity, y: (event.clientY - motion.lastClient.y) * sensitivity }, zoom, geometry, wallSize)
    motion.lastClient = { x: event.clientX, y: event.clientY }
    return delta
  }
  function startDrag(event: PointerEvent<HTMLDivElement>, layer: SceneLayer, device?: Device) {
    if (spaceHeld || event.button !== 0) return
    setSelectedId(layer.id)
    setSelectedDeviceId('')
    dragRef.current = { id: layer.id, deviceId: device?.id, x: layer.x, y: layer.y, lastClient: { x: event.clientX, y: event.clientY } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function dragLayer(event: PointerEvent<HTMLDivElement>) {
    const motion = dragRef.current
    if (!motion) return
    const delta = dragDelta(event, motion)
    if (!delta) return
    const target = motion.deviceId ? devices.find(item => item.id === motion.deviceId) : null
    if (motion.deviceId && !target) return
    const reference = target ? deviceRect(target) : { x: 0, y: 0, ...wallSize }
    const moved = moveEditorLayer(currentScene, { ...currentScene.layers.find(layer => layer.id === motion.id)!, x: motion.x, y: motion.y }, delta, reference)
    motion.x = moved.x
    motion.y = moved.y
    updateLayer(motion.id, { x: motion.x, y: motion.y })
  }
  function startDeviceDrag(event: PointerEvent<HTMLSpanElement>, device: Device) {
    if (isV2 || spaceHeld || event.button !== 0) return
    const geometry = stageGeometry()
    if (!geometry) return
    setSelectedDeviceId(device.id)
    event.currentTarget.focus()
    deviceDragRef.current = {
      id: device.id,
      pointerId: event.pointerId,
      origin: startWorkspaceDrag(
        { x: event.clientX, y: event.clientY },
        { x: device.layout_x ?? 0, y: device.layout_y ?? 0 },
        zoom,
        geometry,
        wallSize,
      ),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }
  function dragDevice(event: PointerEvent<HTMLDivElement>) {
    const motion = deviceDragRef.current
    if (!motion || motion.pointerId !== event.pointerId) return
    const next = advanceWorkspaceDrag(motion.origin, { x: event.clientX, y: event.clientY }, event.shiftKey)
    motion.origin = next.drag
    updateDeviceLayout(motion.id, devicePositionChange(next.position))
  }
  function startPan(event: PointerEvent<HTMLDivElement>) { if (event.button !== 1 && !spaceHeld) return; setPanDrag({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }
  function movePan(event: PointerEvent<HTMLDivElement>) { if (panDrag) setView(current => ({ ...current, pan: { x: panDrag.panX + event.clientX - panDrag.x, y: panDrag.panY + event.clientY - panDrag.y } })) }
  function zoomAt(cursor: Point, next: (zoom: number) => number) {
    const geometry = stageGeometry()
    if (geometry) setView(current => zoomAroundCursor(current, next(current.zoom), geometry, cursor, wallSize))
  }
  function zoomCanvas(event: WheelEvent<HTMLElement>) {
    if (event.target instanceof Element && event.target.closest('.canvas-controls')) return
    event.preventDefault()
    const { clientX, clientY, deltaY, deltaMode } = event
    const pageHeight = event.currentTarget.clientHeight
    zoomAt({ x: clientX, y: clientY }, current => zoomFromWheel(current, deltaY, deltaMode, pageHeight))
  }
  function zoomButton(factor: number) {
    const geometry = stageGeometry()
    if (geometry) zoomAt(geometry.center, current => current * factor)
  }
  function fitScreens() { const stage = stageRef.current, workspace = stageRef.current?.parentElement; if (!stage || !workspace || (!isV2 && !activeDevices.length)) return; const controls = workspace.querySelector<HTMLElement>('.canvas-controls'), hint = workspace.querySelector<HTMLElement>('.canvas-hint'); const fitBounds = isV2 ? { x: 0, y: 0, ...wallSize } : bounds(activeDevices.map(deviceRect)); const fitted = fitEditorView({ bounds: fitBounds, workspace: { width: workspace.clientWidth, height: workspace.clientHeight - (controls?.offsetHeight ?? 0) - (hint?.offsetHeight ?? 0) }, stage: { width: stage.clientWidth, height: stage.clientHeight }, wall: wallSize }); if (fitted) { setView(fitted); setFitZoom(fitted.zoom) } }
  function setMediaSize(layerId: string, sourceWidth: number, sourceHeight: number) { if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return; const layer = currentScene.layers.find((item) => item.id === layerId); if (!layer || (layer.sourceWidth === sourceWidth && layer.sourceHeight === sourceHeight)) return; if (isV2) { updateLayer(layerId, { sourceWidth, sourceHeight, aspectRatio: sourceWidth / sourceHeight }); return } const target = editorDevices.find((item) => isSceneDevice(item.id) && (!layer.target.length || layer.target.includes(item.id))), screenSpace = (layer.space ?? 'screen') === 'screen', referenceWidth = screenSpace ? target?.layout_width ?? 1920 : WALL_WORKSPACE_WIDTH, referenceHeight = screenSpace ? target?.layout_height ?? 1080 : WALL_WORKSPACE_HEIGHT; updateLayer(layerId, { sourceWidth, sourceHeight, aspectRatio: sourceWidth / sourceHeight, width: sourceWidth / referenceWidth * 100, height: sourceHeight / referenceHeight * 100 }) }
  function updateDimension(key: 'width' | 'height', value: number) { if (selected) updateLayer(selected.id, mediaDimensionChange(selected, key, value)) }
  const editorMedia = (layer: SceneLayer) => <EditorMedia layer={layer} liveStream={cameraStream} liveLayerId={cameraLayerId} onSize={(width, height) => setMediaSize(layer.id, width, height)} />
  const editorDeviceRect = (item: Device) => isV2 ? virtualDeviceRects.find(rect => rect.deviceId === item.id) ?? null : deviceRect(item)
  const activeDeviceRects = activeDevices.flatMap(device => { const rect = editorDeviceRect(device); return rect ? [{ device, rect }] : [] })
  const rectStyle = (item: Device): CSSProperties => { const rect = editorDeviceRect(item); return rect ? { left: `${rect.x / wallSize.width * 100}%`, top: `${rect.y / wallSize.height * 100}%`, width: `${rect.width / wallSize.width * 100}%`, height: `${rect.height / wallSize.height * 100}%` } : { display: 'none' } }
  const layerStyle = (layer: SceneLayer): CSSProperties => ({ left: `${layer.x / (isV2 ? wallSize.width : 100) * 100}%`, top: `${layer.y / (isV2 ? wallSize.height : 100) * 100}%`, width: `${layer.width / (isV2 ? wallSize.width : 100) * 100}%`, height: `${layer.height / (isV2 ? wallSize.height : 100) * 100}%`, zIndex: layer.zIndex, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` })
  const clientGuideStyle = (rect: ClientRect, rotation = 0): CSSProperties => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, transform: rotation ? `rotate(${rotation}deg)` : undefined })
  const scaleRectFromCenter = (rect: WorkspaceRect, scale: number): WorkspaceRect => ({ x: rect.x + rect.width * (1 - scale) / 2, y: rect.y + rect.height * (1 - scale) / 2, width: rect.width * scale, height: rect.height * scale })
  const selectedLayerGuides = selected ? (isV2
    ? [{ key: selected.id, rect: scaleRectFromCenter(editorLayerRect(currentScene, selected), selected.scale ?? 1), clip: null, rotation: selected.rotation ?? 0 }]
    : (selected.space ?? 'screen') === 'screen'
    ? activeDevices.filter(device => !selected.target.length || selected.target.includes(device.id)).map(device => {
      const clip = deviceRect(device)
      const rect = scaleRectFromCenter({ x: clip.x + selected.x / 100 * clip.width, y: clip.y + selected.y / 100 * clip.height, width: selected.width / 100 * clip.width, height: selected.height / 100 * clip.height }, selected.scale ?? 1)
      return { key: `${selected.id}-${device.id}`, rect, clip, rotation: selected.rotation ?? 0 }
    })
    : [{ key: selected.id, rect: scaleRectFromCenter({ x: selected.x / 100 * wallSize.width, y: selected.y / 100 * wallSize.height, width: selected.width / 100 * wallSize.width, height: selected.height / 100 * wallSize.height }, selected.scale ?? 1), clip: null, rotation: selected.rotation ?? 0 }]) : []
  const fitSelectedLayer = () => { if (!selected) return; updateLayer(selected.id, isV2 ? fitVirtualLayerToRegions(selected, activeVirtualDeviceRects) : fitLayerToDevices(selected, activeDevices)) }
  const renderedLayers = isV2
    ? currentScene.layers.map(layer => <div key={layer.id} className={`canvas-layer ${layer.id === selectedId ? 'selected-layer' : ''}`} style={layerStyle(layer)} onPointerDown={(event) => startDrag(event, layer)}>{editorMedia(layer)}</div>)
    : currentScene.layers.map((layer) => (layer.space ?? 'screen') === 'screen' ? editorDevices.filter((item) => isSceneDevice(item.id) && (!layer.target.length || layer.target.includes(item.id))).map((item) => <div className="screen-layer-clip" key={`${layer.id}-${item.id}`} style={{ ...rectStyle(item), zIndex: layer.zIndex }}><div className={`canvas-layer ${layer.id === selectedId ? 'selected-layer' : ''}`} style={{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, opacity: layer.opacity ?? 1, transform: `rotate(${layer.rotation ?? 0}deg) scale(${layer.scale ?? 1})` }} onPointerDown={(event) => startDrag(event, layer, item)}>{editorMedia(layer)}</div></div>) : <div key={layer.id} className={`canvas-layer ${layer.id === selectedId ? 'selected-layer' : ''}`} style={layerStyle(layer)} onPointerDown={(event) => startDrag(event, layer)}>{editorMedia(layer)}</div>)
  return <main className="editor-page"><header className="editor-header"><a href="/">← Dashboard</a><div><input aria-label="Scene name" value={currentScene.name} onChange={(event) => setScene({ ...currentScene, name: event.target.value })} /><p>{isV2 ? `Geometry: V2 virtual-pixel · Canvas: ${wallSize.width} × ${wallSize.height} px · Wall revision: ${virtualGeometry?.status === 'valid' && virtualGeometry.geometryRevision === currentScene.wall_geometry_revision ? 'current' : 'changed'}` : 'Scene editor · Legacy V1 geometry'}</p></div><div className="editor-actions"><button className="secondary" disabled={isV2 || !layoutDirty} onClick={() => void saveLayout()}>Save screen layout</button><button onClick={() => void save()}>Save scene</button></div></header>{revisionWarning && <section className="editor-geometry-warning"><p>{revisionWarning}</p>{hasRevisionMismatch && wallContract.status === 'valid' && <><p>The physical wall layout changed. Updating adopts the new screen positions and canvas size. Layer positions and sizes will not be changed.</p><button onClick={() => void updateToCurrentWallLayout()}>Update to current wall layout</button></>}</section>}<div className="editor-layout">
    <aside className="editor-toolbar">
      <section className="editor-sidebar-group">
        <div className="editor-sidebar-heading"><p className="eyebrow">SCREENS IN THIS SCENE</p><span>{activeDevices.length} / {editorDevices.length}</span></div>
        <div className="screen-list"><small>{isV2 ? 'Device outlines use the wall’s current normalized virtual-pixel regions. Edit calibration outside this scene.' : 'Choose displays, then place their lit image areas. Left/Top include bezels and gaps. Save screen layout to apply changes to the players.'}</small>{editorDevices.map((item) => <details className="screen-list-item" key={item.id}><summary><input aria-label={`Use ${item.name} in this scene`} type="checkbox" checked={isSceneDevice(item.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSceneDevice(item.id)} /><span>{item.name}</span></summary>{isV2 ? <div className="screen-details-body"><small>{(() => { const rect = editorDeviceRect(item); return rect ? `${rect.x}, ${rect.y} · ${rect.width} × ${rect.height} virtual px` : 'Virtual region unavailable' })()}</small></div> : <div className="screen-details-body"><label>Name<input value={item.name} onChange={(event) => updateDeviceLayout(item.id, { name: event.target.value })} /></label><ScreenLayoutControls device={item} onChange={change => updateDeviceLayout(item.id, change)} /></div>}</details>)}</div>
        {!isV2 && activeDevices.some(d => d.auto_size === false) && activeDevices.some(d => d.auto_size !== false) && <p className="notice">Mixed layout units: enter measured sizes for every selected screen before aligning them.</p>}
        <small>{isV2 ? 'The persisted scene canvas remains fixed even if current wall geometry changes.' : 'Screen outlines stay above media. Drag a screen label to position that display independently.'}</small>
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
      {selected && <section className="editor-sidebar-group editor-layer-settings"><p className="eyebrow">LAYER DISPLAY</p><div className="wall-layer-controls"><label>Layer canvas<select disabled={isV2} value={isV2 ? 'wall' : selected.space ?? 'screen'} onChange={(event) => updateLayer(selected.id, { space: event.target.value as 'screen' | 'wall' })}>{!isV2 && <option value="screen">One copy on each selected display</option>}<option value="wall">Full wall — span and crop across displays</option></select></label><div className="target-picker"><span>This layer appears on</span>{editorDevices.map((item) => <label key={item.id} className={!isSceneDevice(item.id) ? 'disabled-target' : ''}><input type="checkbox" disabled={!isSceneDevice(item.id)} checked={isSceneDevice(item.id) && (!selected.target.length || selected.target.includes(item.id))} onChange={() => toggleTarget(item.id)} /> {item.name}</label>)}</div></div></section>}
    </aside>
    <section className="editor-stage-wrap" onWheel={zoomCanvas}><div className="canvas-controls"><button className="secondary" onClick={() => zoomButton(1 / 1.1)}>−</button><span>{Math.round(displayedZoomPercent(zoom, fitZoom))}%</span><button className="secondary" onClick={() => zoomButton(1.1)}>+</button><button className="secondary" onClick={fitScreens}>{isV2 ? 'Fit canvas' : 'Fit screens'}</button><button className="secondary" onClick={() => setView({ zoom: 1, pan: { x: 0, y: 0 } })}>Reset</button></div><div ref={stageRef} className={`editor-stage media-workspace ${isV2 ? 'virtual-pixel-stage' : ''} ${spaceHeld || panDrag ? 'panning-workspace' : ''}`} style={{ aspectRatio: `${wallSize.width} / ${wallSize.height}`, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} onPointerDown={startPan} onPointerMove={(event) => { movePan(event); dragLayer(event); dragDevice(event) }} onPointerUp={() => { dragRef.current = null; deviceDragRef.current = null; setPanDrag(null) }} onPointerCancel={() => { dragRef.current = null; deviceDragRef.current = null; setPanDrag(null) }}>{renderedLayers}{editorDevices.map((item) => <div className={`device-mask ${isSceneDevice(item.id) ? '' : 'inactive-device'} ${item.id === selectedDeviceId ? 'selected-device' : ''}`} key={item.id} style={rectStyle(item)}><span tabIndex={0} role="button" aria-label={`${isV2 ? 'Select' : 'Select and move'} ${item.name}`} style={{ transform: `scale(${1 / zoom})` }} onFocus={() => setSelectedDeviceId(item.id)} onPointerDown={(event) => startDeviceDrag(event, item)}>{item.name}</span></div>)}</div>{overlayStage && <div className={`editor-guide-overlay ${isV2 ? 'virtual-pixel-guide-overlay' : ''}`}><div className="workspace-screen-guide" style={clientGuideStyle(workspaceRectToClientRect({ x: 0, y: 0, ...wallSize }, view, overlayStage, wallSize))} />{activeDeviceRects.map(({ device, rect }) => <div key={device.id} className={`device-screen-guide ${device.id === selectedDeviceId ? 'selected-device-guide' : ''}`} style={clientGuideStyle(workspaceRectToClientRect(rect, view, overlayStage, wallSize))} />)}{selectedLayerGuides.map(guide => { const rect = workspaceRectToClientRect(guide.rect, view, overlayStage, wallSize); if (!guide.clip) return <div key={guide.key} className="layer-screen-guide" style={clientGuideStyle(rect, guide.rotation)} />; const clip = workspaceRectToClientRect(guide.clip, view, overlayStage, wallSize); return <div key={guide.key} className="layer-screen-guide-clip" style={clientGuideStyle(clip)}><div className="layer-screen-guide" style={clientGuideStyle({ left: rect.left - clip.left, top: rect.top - clip.top, width: rect.width, height: rect.height }, guide.rotation)} /></div> })}</div>}<p className="canvas-hint">{isV2 ? 'Scroll to zoom · Space or middle drag to pan · Layer geometry is stored in virtual pixels · Shift drags at 0.1×.' : 'Scroll to zoom · Space or middle drag to pan · Arrow keys move a selected screen by 1 unit · Shift uses 0.1.'}</p></section>
    <aside className="inspector">
      <p className="eyebrow">{selected ? 'MEDIA LAYER' : 'INSPECTOR'}</p>
      {selected ? <>
        <section className="inspector-section" aria-label="Source">
          <h2>Source</h2>
          <label>Type<select value={selected.type} disabled={selected.type === 'live'} onChange={(event) => updateLayer(selected.id, { type: event.target.value as 'image' | 'video' })}><option value="image">Image</option><option value="video">Video</option>{selected.type === 'live' && <option value="live">Live input</option>}</select></label>
          {selected.type === 'live' ? <><p>Live source: {selected.content.liveSourceId || 'Not assigned'}. This preview stays in this browser.</p><div className="live-camera-controls"><button className="secondary" onClick={() => void listCameras()}>Find cameras</button>{cameraDevices.length > 0 && <label>Camera<select value={selectedCameraId} onChange={(event) => { const nextCameraId = event.target.value; setSelectedCameraId(nextCameraId); if (cameraStream && cameraLayerId === selected.id) void startCamera(nextCameraId) }}>{cameraDevices.map((camera, index) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}</select></label>}<button onClick={() => void startCamera()}>{cameraStream && cameraLayerId === selected.id ? 'Restart preview' : 'Enable preview'}</button>{cameraStream && cameraLayerId === selected.id && <button className="secondary" onClick={stopCamera}>Disable preview</button>}</div>{cameraError && <p className="live-camera-message">{cameraError}</p>}<div className="live-camera-controls"><span>{selectedLiveTargets.length} target{selectedLiveTargets.length === 1 ? '' : 's'} from layer targeting</span><button disabled={!selectedLiveTargets.length} onClick={() => void startLiveSession()}>Start live session</button>{liveSessionActive && <button className="secondary" onClick={() => stopLiveSession()}>End session</button>}</div><small>To change targets while streaming: end the session, save the layer targeting, then start again.</small><p className="live-camera-message">{liveSessionActive ? `${connectedTargetCount}/${Object.keys(targetStatuses).length} targets WebRTC connected` : liveSessionStatus}</p>{Object.values(targetStatuses).map(status => <p className="live-camera-message" key={status.deviceId}><strong>{status.name}</strong> — signaling {status.signaling} · ready {status.peerReady ? 'yes' : 'no'} · WebRTC {status.connectionState} · ICE {status.iceConnectionState}</p>)}</> : <><label>Media URL<input type="url" value={selected.content.url ?? ''} onChange={(event) => updateContent('url', event.target.value)} placeholder="Legacy or direct URL" /></label><div className="media-source-actions"><button type="button" onClick={() => setMediaPickerOpen(true)}>Choose from library</button><label className="upload-button">Upload new<input type="file" accept={selected.type === 'video' ? 'video/mp4' : 'image/jpeg,image/png,image/webp'} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadNewMedia(file) }} /></label></div>{selected.content.mediaAssetId && <small>Library asset: {selected.content.mediaAssetId}</small>}</>}
        </section>
        <section className="inspector-section" aria-label="Fit and display">
          <h2>Fit / Display</h2>
          {selected.type !== 'live' && <label>Image fit<select value={selected.content.fit ?? 'cover'} onChange={event => updateLayer(selected.id, { content: { ...selected.content, fit: event.target.value as 'cover' | 'contain' } })}><option value="cover">Fill layer (crop edges)</option><option value="contain">Show whole image</option></select></label>}
          <label><input type="checkbox" checked={selected.lockedAspect !== false} onChange={(event) => updateLayer(selected.id, { lockedAspect: event.target.checked })} /> Lock media aspect ratio</label>
          <button className="secondary" disabled={!activeDevices.length} onClick={fitSelectedLayer}>Fit layer to selected screens</button>
        </section>
        <section className="inspector-section" aria-label="Transform">
          <h2>Transform</h2>
          <div className="position-grid"><label>{isV2 ? 'X (px)' : 'x'}<input type="number" value={selected.x} onChange={(event) => updateLayer(selected.id, { x: Number(event.target.value) })} /></label><label>{isV2 ? 'Y (px)' : 'y'}<input type="number" value={selected.y} onChange={(event) => updateLayer(selected.id, { y: Number(event.target.value) })} /></label><label>{isV2 ? 'Width (px)' : 'width'}<input type="number" min="0" value={selected.width} onChange={(event) => updateDimension('width', Number(event.target.value))} /></label><label>{isV2 ? 'Height (px)' : 'height'}<input type="number" min="0" value={selected.height} onChange={(event) => updateDimension('height', Number(event.target.value))} /></label></div>
          <div className="position-grid"><label>Rotation (degrees)<input type="number" value={selected.rotation ?? 0} onChange={(event) => updateLayer(selected.id, { rotation: Number(event.target.value) })} /></label><label>Scale<input type="number" min="0.1" max="5" step="0.01" value={selected.scale ?? 1} onChange={(event) => updateLayer(selected.id, { scale: Math.max(.1, Number(event.target.value)) })} /></label></div>
        </section>
        <section className="inspector-section" aria-label="Layer">
          <h2>Layer</h2>
          <div className="stack-controls"><button className="secondary" onClick={() => moveLayer('up')}>Bring forward</button><button className="secondary" onClick={() => moveLayer('down')}>Send backward</button></div>
          <button className="danger" onClick={removeSelected}>Remove layer</button>
        </section>
      </> : <p>Select an image or video layer to edit it.</p>}
    </aside>
  </div>{notice && <p className="editor-notice">{notice}</p>}{mediaPickerOpen && selected && (selected.type === 'image' || selected.type === 'video') && <MediaLibrary mode="picker" allowedType={selected.type} onSelect={selectMediaAsset} onClose={() => setMediaPickerOpen(false)} />}</main>
}
