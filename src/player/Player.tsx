import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { isConfigured, supabase } from '../lib/supabase'
import type { Device, PlaylistRuntime, Scene, SceneLayer } from '../types'
import { ScenePreview, type ScenePreviewProps } from '../rendering/ScenePreview'
import { parseServerSignalingMessage, scopedClientMessage, SIGNALING_VERSION, type AuthenticatedMessage, type LiveSessionLease } from '../signalingProtocol'
import { addOrQueueIceCandidate, flushIceCandidates, webRtcConfiguration, type PendingIceCandidate } from '../lib/webrtc'
import { recoveryDelayMs } from '../lib/recovery'
import { parseVirtualWallGeometry, sceneGeometryVersion, validateV2SceneRender, type VirtualWallGeometryResult } from '../lib/virtualWallGeometry'
import { geometryDebugRows, liveDebugRows, mediaDebugRows, mergeLiveSourceDiagnostic, playerHealthSummary, playlistDebugRows, shortDebugId, type DebugRow, type LiveDebugState, type LiveSourceDiagnostic } from './playerDebug'
import { playlistActivationRemainingMs, playlistLoadingOverlayState, playlistPollIntervalMs, preparePlaylistScene, type PlaylistLoadingOverlayState } from '../lib/playlistRuntime'
import { liveSessionConnectionIdentity, liveSessionLeaseIsActive } from '../lib/liveSessionConnection'
import { mergeStatsReports, normalizeReceiverStats } from '../lib/livePerformanceStats'

const WEBRTC_DISCONNECT_GRACE_MS = 5000

function PlayerLiveSession({ device, lease, disabled, diagnosticsEnabled, onStream, onRemove, onStatus, onDiagnostic }: { device: { id: string; token: string }; lease: LiveSessionLease; disabled: boolean; diagnosticsEnabled: boolean; onStream: (sourceId: string, stream: MediaStream) => void; onRemove: (sourceId: string) => void; onStatus: (sourceId: string, status: LiveDebugState) => void; onDiagnostic: (sourceId: string, update: LiveSourceDiagnostic) => void }) {
  const socketRef = useRef<WebSocket | null>(null)
  const scopeRef = useRef<AuthenticatedMessage | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const pendingRef = useRef<PendingIceCandidate[]>([])
  const expiresAtRef = useRef(lease.expiresAt)
  const callbacksRef = useRef({ onStream, onRemove, onStatus, onDiagnostic })
  expiresAtRef.current = lease.expiresAt
  callbacksRef.current = { onStream, onRemove, onStatus, onDiagnostic }
  const connectionIdentity = liveSessionConnectionIdentity(device, lease)
  useEffect(() => { onDiagnostic(lease.liveSourceId, { sessionId: lease.sessionId, targetDeviceId: lease.targetDeviceId, expiresAt: lease.expiresAt }) }, [lease.sessionId, lease.liveSourceId, lease.targetDeviceId, lease.expiresAt, onDiagnostic])
  useEffect(() => {
    const { id: deviceId, token: deviceToken } = device
    const { sessionId, liveSourceId, targetDeviceId, signalingUrl } = lease
    let stopped = false
    let retries = 0
    let retryTimer = 0
    let statsTimer = 0
    let previousStats: ReturnType<typeof normalizeReceiverStats>['snapshot'] | undefined
    const report = (update: LiveSourceDiagnostic) => callbacksRef.current.onDiagnostic(liveSourceId, { sessionId, targetDeviceId, expiresAt: expiresAtRef.current, ...update })
    const closePeer = () => { window.clearInterval(statsTimer); statsTimer = 0; previousStats = undefined; const peer = peerRef.current; peerRef.current = null; pendingRef.current.splice(0); if (peer) { peer.onicecandidate = null; peer.ontrack = null; peer.onconnectionstatechange = null; peer.oniceconnectionstatechange = null; peer.close(); report({ peerConnectionState: 'closed', iceConnectionState: 'closed' }) } }
    const sampleStats = (peer: RTCPeerConnection) => {
      const videoReceivers = peer.getReceivers().filter(receiver => receiver.track?.kind === 'video')
      void Promise.all([peer.getStats(), ...videoReceivers.map(receiver => receiver.getStats())]).then(reports => {
        if (peer !== peerRef.current) return
        const normalized = normalizeReceiverStats(mergeStatsReports(reports), previousStats, Date.now(), { receiverReport: mergeStatsReports(reports.slice(1)), statsEntries: mergeStatsReports(reports).length, videoReceivers: videoReceivers.length })
        previousStats = normalized.snapshot
        report({ receiverStats: normalized.stats, peerConnectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState })
      }).catch(() => undefined)
    }
    const send = <T extends 'answer' | 'ice-candidate'>(scope: AuthenticatedMessage, type: T, payload: T extends 'answer' ? { sdp: string } : { candidate: string | null; sdpMid: string | null; sdpMLineIndex: number | null }) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(scopedClientMessage(scope, type, payload)))
    }
    const retry = () => { if (!stopped && liveSessionLeaseIsActive(expiresAtRef.current)) { callbacksRef.current.onStatus(liveSourceId, 'RECONNECTING'); retryTimer = window.setTimeout(connect, recoveryDelayMs(retries++)) } }
    function connect() {
      if (stopped) return
      callbacksRef.current.onStatus(liveSourceId, 'CONNECTING')
      report({ socketState: 'CONNECTING', socketError: false })
      let socket: WebSocket
      try { socket = new WebSocket(signalingUrl) } catch { callbacksRef.current.onStatus(liveSourceId, 'ERROR'); retry(); return }
      socketRef.current = socket
      socket.addEventListener('open', () => { if (!stopped && socketRef.current === socket) { report({ socketState: 'OPEN' }); socket.send(JSON.stringify({ version: SIGNALING_VERSION, type: 'auth', role: 'player', deviceId, deviceToken, sessionId })) } })
      socket.addEventListener('message', event => { void (async () => {
        if (stopped || socketRef.current !== socket || typeof event.data !== 'string') return
        const message = parseServerSignalingMessage(event.data)
        if (!message) return
        if (message.type === 'authenticated' && message.role === 'player' && message.sessionId === sessionId && message.liveSourceId === liveSourceId && message.targetDeviceId === targetDeviceId && targetDeviceId === deviceId) {
          scopeRef.current = message
          report({ generation: message.generation })
          retries = 0; callbacksRef.current.onStatus(liveSourceId, 'CONNECTED')
          socket.send(JSON.stringify(scopedClientMessage(message, 'peer-ready', {})))
        } else if (message.type === 'offer' && !disabled) {
          const scope = scopeRef.current
          if (!scope || message.sessionId !== scope.sessionId || message.liveSourceId !== scope.liveSourceId || message.targetDeviceId !== scope.targetDeviceId || message.generation !== scope.generation) return
          closePeer(); callbacksRef.current.onStatus(liveSourceId, 'NEGOTIATING')
          const peer = new RTCPeerConnection(webRtcConfiguration(import.meta.env.VITE_WEBRTC_STUN_URLS)); peerRef.current = peer
          report({ peerConnectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState })
          peer.onicecandidate = event => send(scope, 'ice-candidate', event.candidate ? { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex } : { candidate: null, sdpMid: null, sdpMLineIndex: null })
          peer.ontrack = event => { if (peer === peerRef.current && event.track.kind === 'video') { callbacksRef.current.onStream(scope.liveSourceId, event.streams[0] ?? new MediaStream([event.track])); callbacksRef.current.onStatus(liveSourceId, 'STREAMING') } }
          peer.onconnectionstatechange = () => { if (peer === peerRef.current) { report({ peerConnectionState: peer.connectionState }); if (peer.connectionState === 'failed' || peer.connectionState === 'closed') { callbacksRef.current.onStatus(liveSourceId, 'RECONNECTING'); closePeer(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(scopedClientMessage(scope, 'peer-ready', {}))) } } }
          peer.oniceconnectionstatechange = () => { if (peer === peerRef.current) report({ iceConnectionState: peer.iceConnectionState }) }
          if (diagnosticsEnabled) { sampleStats(peer); statsTimer = window.setInterval(() => sampleStats(peer), 2000) }
          await peer.setRemoteDescription({ type: 'offer', sdp: message.payload.sdp }); await flushIceCandidates(peer, pendingRef.current)
          const answer = await peer.createAnswer(); if (peer !== peerRef.current) return; await peer.setLocalDescription(answer)
          if (peer.localDescription?.sdp) send(scope, 'answer', { sdp: peer.localDescription.sdp })
        } else if (message.type === 'ice-candidate') {
          const scope = scopeRef.current
          if (scope && message.sessionId === scope.sessionId && message.liveSourceId === scope.liveSourceId && message.targetDeviceId === scope.targetDeviceId && message.generation === scope.generation) await addOrQueueIceCandidate(peerRef.current, message.payload.candidate === null ? null : { candidate: message.payload.candidate, sdpMid: message.payload.sdpMid, sdpMLineIndex: message.payload.sdpMLineIndex }, pendingRef.current)
        } else if (message.type === 'session-ended') { callbacksRef.current.onStatus(liveSourceId, 'ENDED'); closePeer(); callbacksRef.current.onRemove(liveSourceId); socket.close() }
      })() })
      socket.addEventListener('error', () => report({ socketError: true }))
      socket.addEventListener('close', event => { report({ socketState: 'CLOSED', lastCloseCode: event.code, lastCloseReason: event.reason, lastCloseWasClean: event.wasClean, lastCloseAtMs: Date.now() }); if (!stopped && socketRef.current === socket) { socketRef.current = null; retry() } })
    }
    connect()
    return () => { stopped = true; window.clearTimeout(retryTimer); closePeer(); socketRef.current?.close(1000, 'lease-changed'); callbacksRef.current.onRemove(liveSourceId) }
  }, [connectionIdentity, disabled, diagnosticsEnabled])
  return null
}

function DebugSection({ title, rows }: { title: string; rows: DebugRow[] }) {
  return <section><strong>{title}</strong>{rows.map(row => <div className="player-debug-row" key={`${title}:${row.label}`}><span>{row.label}</span><b>{row.value}</b>{row.detail && <small>{row.detail}</small>}</div>)}</section>
}

function PlayerDebugOverlay({ device, deviceName, wallId, scene, playlistRuntime, status, geometryRows, signalingStatus, liveRows, mediaRows, health, webRtcConnectionState, iceConnectionState }: { device: { id: string } | null; deviceName: string | null; wallId: string | null; scene: Scene | null; playlistRuntime: PlaylistRuntime | null; status: string; geometryRows: DebugRow[]; signalingStatus: string; liveRows: DebugRow[]; mediaRows: DebugRow[]; health: string; webRtcConnectionState: string; iceConnectionState: string }) {
  return <aside className="player-debug" aria-label="ScreenMesh player diagnostics"><header><strong>SCREENMESH PLAYER</strong><b>{health}</b></header><DebugSection title="Device" rows={[{ label: 'Status', value: device ? 'PAIRED' : 'UNPAIRED' }, { label: 'Name', value: deviceName ?? 'Unknown device' }, { label: 'ID', value: shortDebugId(device?.id) }, { label: 'Wall', value: wallId ? shortDebugId(wallId) : 'No wall' }, { label: 'Scene', value: scene ? `${scene.name} (${shortDebugId(scene.id)})` : 'No active scene' }, { label: 'Polling', value: status }]} /><DebugSection title="Geometry" rows={geometryRows} /><DebugSection title="Playlist" rows={playlistDebugRows(playlistRuntime)} /><DebugSection title="Legacy runtime" rows={[{ label: 'Signaling', value: signalingStatus.toUpperCase() }, { label: 'WebRTC', value: webRtcConnectionState.toUpperCase() }, { label: 'ICE', value: iceConnectionState.toUpperCase() }]} /><DebugSection title="Live sources" rows={liveRows.length ? liveRows : [{ label: 'Sources', value: 'None' }]} /><DebugSection title="Media" rows={mediaRows} /></aside>
}

function PlaylistLoadingOverlay({ runtime, scene, serverEpochOffsetMs, ...props }: { runtime: PlaylistRuntime | null; scene: Scene | null; serverEpochOffsetMs: number } & Omit<ScenePreviewProps, 'scene' | 'player' | 'serverEpochOffsetMs'>) {
  const [presentation, setPresentation] = useState<PlaylistLoadingOverlayState>(() => playlistLoadingOverlayState(runtime, performance.now() + serverEpochOffsetMs))
  useEffect(() => {
    let frame = 0, timer = 0, stopped = false
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    const update = () => {
      if (stopped) return
      const now = performance.now() + serverEpochOffsetMs
      const next = playlistLoadingOverlayState(runtime, now, reducedMotion)
      setPresentation(next)
      if (next.animate) frame = requestAnimationFrame(update)
      else if (next.nextAtMs !== null && next.nextAtMs > now) timer = window.setTimeout(update, next.nextAtMs - now)
    }
    update()
    return () => { stopped = true; cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [runtime?.generation, runtime?.sequence, runtime?.phase, runtime?.status, runtime?.loading_at, runtime?.activation_at, serverEpochOffsetMs])
  if (!scene || !presentation.mounted) return null
  const mutedScene = { ...scene, layers: scene.layers.map(layer => layer.type === 'video' ? { ...layer, content: { ...layer.content, muted: true } } : layer) }
  return <div className="playlist-loading-overlay" data-overlay-phase={presentation.phase} style={{ opacity: presentation.opacity }} aria-hidden="true"><ScenePreview {...props} scene={mutedScene} player serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={runtime?.loading_at ? Date.parse(runtime.loading_at) : 0} /></div>
}

export function Player() {
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
  const [serverEpochOffsetMs, setServerEpochOffsetMs] = useState(() => Date.now() - performance.now())
  const serverEpochOffsetRef = useRef(serverEpochOffsetMs)
  serverEpochOffsetRef.current = serverEpochOffsetMs
  const [wallDevices, setWallDevices] = useState<Device[]>([])
  const [virtualWallGeometry, setVirtualWallGeometry] = useState<VirtualWallGeometryResult | null>(null)
  const [sceneStartedAtMs, setSceneStartedAtMs] = useState(0)
  const [playlistRuntime, setPlaylistRuntime] = useState<PlaylistRuntime | null>(null)
  const [playlistTargetScene, setPlaylistTargetScene] = useState<Scene | null>(null)
  const [playlistLoadingScene, setPlaylistLoadingScene] = useState<Scene | null>(null)
  const reportedPreparationRef = useRef('')
  const preloadedLoadingRef = useRef('')
  const [liveSession, setLiveSession] = useState<LiveSessionLease | null>(null)
  const [liveSessions, setLiveSessions] = useState<LiveSessionLease[]>([])
  const liveSessionRef = useRef<LiveSessionLease | null>(null)
  liveSessionRef.current = liveSession
  const [signalingStatus, setSignalingStatus] = useState('idle')
  const signalingSocketRef = useRef<WebSocket | null>(null)
  const signalingScopeRef = useRef<AuthenticatedMessage | null>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const peerScopeRef = useRef<AuthenticatedMessage | null>(null)
  const disconnectGraceTimerRef = useRef<number | null>(null)
  const pendingIceCandidatesRef = useRef<PendingIceCandidate[]>([])
  const [liveStreams, setLiveStreams] = useState<Map<string, MediaStream>>(() => new Map())
  const [webRtcConnectionState, setWebRtcConnectionState] = useState<RTCPeerConnectionState | 'idle'>('idle')
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState | 'idle'>('idle')
  const [hasRemoteVideoTrack, setHasRemoteVideoTrack] = useState(false)
  const [liveSourceStates, setLiveSourceStates] = useState<Record<string, LiveDebugState>>({})
  const [liveSourceDiagnostics, setLiveSourceDiagnostics] = useState<Record<string, LiveSourceDiagnostic>>({})
  const [mediaStates, setMediaStates] = useState<Record<string, string>>({})
  const registerLiveStream = useCallback((liveSourceId: string, stream: MediaStream) => setLiveStreams(current => new Map(current).set(liveSourceId, stream)), [])
  const removeLiveStream = useCallback((liveSourceId: string) => setLiveStreams(current => { current.get(liveSourceId)?.getTracks().forEach(track => track.stop()); const next = new Map(current); next.delete(liveSourceId); return next }), [])
  const setLiveSourceStatus = useCallback((liveSourceId: string, nextStatus: LiveDebugState) => setLiveSourceStates(current => current[liveSourceId] === nextStatus ? current : { ...current, [liveSourceId]: nextStatus }), [])
  const setLiveSourceDiagnostic = useCallback((liveSourceId: string, update: LiveSourceDiagnostic) => setLiveSourceDiagnostics(current => {
    return { ...current, [liveSourceId]: mergeLiveSourceDiagnostic(current[liveSourceId], update) }
  }), [])
  const setLivePresentationFps = useCallback((liveSourceId: string, presentationFps: number) => setLiveSourceDiagnostics(current => ({ ...current, [liveSourceId]: { ...current[liveSourceId], receiverStats: { ...current[liveSourceId]?.receiverStats, presentationFps } } })), [])
  const setMediaStatus = useCallback((layerId: string, nextStatus: string) => setMediaStates(current => current[layerId] === nextStatus ? current : { ...current, [layerId]: nextStatus }), [])
  const ignoreLiveSourceStatus = useCallback((_liveSourceId: string, _nextStatus: LiveDebugState) => undefined, [])
  const ignoreLiveSourceDiagnostic = useCallback((_liveSourceId: string, _update: LiveSourceDiagnostic) => undefined, [])

  useEffect(() => {
    if (!device || !supabase) return
    let cancelled = false
    const client = supabase
    const calibrateClock = async () => {
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
    let cancelled = false
    let timer = 0
    let lastHeartbeatAt = 0
    const client = supabase
    const refresh = async () => {
      const { data, error } = await client.rpc('get_player_state', { requested_device_id: device.id, requested_token: device.token })
      if (cancelled) return null
      if (error) { setStatus('Connection issue — retrying…'); return null }
      const runtime = data?.playlist_runtime as PlaylistRuntime | null
      const targetScene = data?.target_scene ? { ...data.target_scene, layers: data.target_scene.layers as SceneLayer[] } as Scene : null
      const activationRemaining = playlistActivationRemainingMs(runtime, performance.now() + serverEpochOffsetRef.current)
      if (runtime?.phase === 'ARMED' && targetScene && activationRemaining === 0) setScene(targetScene)
      else if (data?.scene) setScene({ ...data.scene, layers: data.scene.layers as SceneLayer[] })
      else setScene(null)
      if (data?.devices) setWallDevices(data.devices as Device[])
      setVirtualWallGeometry(parseVirtualWallGeometry(data?.virtual_wall_geometry))
      if (runtime?.phase === 'ARMED' && runtime.activation_at && activationRemaining === 0) setSceneStartedAtMs(Date.parse(runtime.activation_at))
      else if (data?.scene_started_at) setSceneStartedAtMs(new Date(data.scene_started_at).getTime())
      setPlaylistRuntime(runtime ?? null)
      setPlaylistTargetScene(targetScene)
      setPlaylistLoadingScene(data?.loading_scene ? { ...data.loading_scene, layers: data.loading_scene.layers as SceneLayer[] } : null)
      let effectiveRuntime = runtime
      if (runtime && runtime.status !== 'STOPPED') {
        const { data: advanced } = await client.rpc('advance_playlist_if_due', { requested_device_id: device.id, requested_token: device.token, expected_generation: runtime.generation, expected_sequence: runtime.sequence })
        if (!cancelled && advanced && typeof advanced === 'object') { effectiveRuntime = advanced as PlaylistRuntime; setPlaylistRuntime(effectiveRuntime) }
      }
      if (data?.loading_scene && runtime?.generation && preloadedLoadingRef.current !== runtime.generation) {
        preloadedLoadingRef.current = runtime.generation
        void preparePlaylistScene({ ...data.loading_scene, layers: data.loading_scene.layers as SceneLayer[] }, videosDisabled).catch(() => undefined)
      }
      const discovered = Array.isArray(data?.live_sessions) ? data.live_sessions as LiveSessionLease[] : data?.live_session ? [data.live_session as LiveSessionLease] : []
      setLiveSessions(discovered.filter(lease => new Date(lease.expiresAt).getTime() > Date.now()))
      setLiveSession(null)
      setStatus('Connected')
      if (Date.now() - lastHeartbeatAt >= 4_000) { lastHeartbeatAt = Date.now(); await client.rpc('player_heartbeat', { requested_device_id: device.id, requested_token: device.token, viewport_width: innerWidth, viewport_height: innerHeight }) }
      return effectiveRuntime
    }
    const poll = async () => { const runtime = await refresh(); if (!cancelled) timer = window.setTimeout(() => void poll(), playlistPollIntervalMs(runtime)) }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [device])

  useEffect(() => {
    if (playlistRuntime?.phase !== 'ARMED' || !playlistRuntime.activation_at || !playlistTargetScene || playlistTargetScene.id !== playlistRuntime.target_scene_id) return
    const activationAt = Date.parse(playlistRuntime.activation_at)
    if (!Number.isFinite(activationAt)) return
    const activate = () => { setScene(playlistTargetScene); setSceneStartedAtMs(activationAt) }
    const delay = Math.max(0, activationAt - (performance.now() + serverEpochOffsetRef.current))
    if (delay === 0) { activate(); return }
    const timer = window.setTimeout(activate, delay)
    return () => window.clearTimeout(timer)
  }, [playlistRuntime?.generation, playlistRuntime?.sequence, playlistRuntime?.phase, playlistRuntime?.activation_at, playlistRuntime?.target_scene_id, playlistTargetScene?.id])

  useEffect(() => {
    if (!device || !supabase || !playlistRuntime || playlistRuntime.phase !== 'PREPARING' || !playlistTargetScene || playlistTargetScene.id !== playlistRuntime.target_scene_id) return
    const preparationKey = `${playlistRuntime.generation}:${playlistRuntime.sequence}:${playlistTargetScene.id}`
    if (reportedPreparationRef.current === preparationKey) return
    reportedPreparationRef.current = preparationKey
    let cancelled = false
    void preparePlaylistScene(playlistTargetScene, videosDisabled).then(async () => {
      if (!cancelled && supabase) await supabase.rpc('report_playlist_ready', { requested_device_id: device.id, requested_token: device.token, expected_generation: playlistRuntime.generation, expected_sequence: playlistRuntime.sequence, expected_target_scene_id: playlistTargetScene.id, readiness_state: 'READY', readiness_detail: null })
    }).catch(async error => {
      if (!cancelled && supabase) await supabase.rpc('report_playlist_ready', { requested_device_id: device.id, requested_token: device.token, expected_generation: playlistRuntime.generation, expected_sequence: playlistRuntime.sequence, expected_target_scene_id: playlistTargetScene.id, readiness_state: 'ERROR', readiness_detail: error instanceof Error ? error.message : 'media-preparation-failed' })
    })
    return () => { cancelled = true }
  }, [device, playlistRuntime?.generation, playlistRuntime?.sequence, playlistRuntime?.phase, playlistRuntime?.target_scene_id, playlistTargetScene, videosDisabled])

  function clearDisconnectGraceTimer() {
    if (disconnectGraceTimerRef.current === null) return
    window.clearTimeout(disconnectGraceTimerRef.current)
    disconnectGraceTimerRef.current = null
  }
  function closePlayerPeerConnection(resetState = true, clearStreams = true) {
    clearDisconnectGraceTimer()
    const peer = peerConnectionRef.current
    peerConnectionRef.current = null
    peerScopeRef.current = null
    pendingIceCandidatesRef.current.splice(0)
    if (peer) {
      peer.onicecandidate = null
      peer.ontrack = null
      peer.onconnectionstatechange = null
      peer.oniceconnectionstatechange = null
      peer.close()
    }
    if (clearStreams) {
      setLiveStreams(current => {
        return current.size ? new Map() : current
      })
      setHasRemoteVideoTrack(false)
    }
    if (resetState) { setWebRtcConnectionState('idle'); setIceConnectionState('idle') }
  }
  function sendPlayerWebRtcMessage<T extends 'answer' | 'ice-candidate'>(scope: AuthenticatedMessage, type: T, payload: T extends 'answer' ? { sdp: string } : { candidate: string | null; sdpMid: string | null; sdpMLineIndex: number | null }) {
    const socket = signalingSocketRef.current
    if (socket?.readyState !== WebSocket.OPEN || signalingScopeRef.current?.sessionId !== scope.sessionId) throw new Error('Signaling session is unavailable')
    socket.send(JSON.stringify(scopedClientMessage(scope, type, payload)))
  }
  function requestFreshPlayerOffer(scope = signalingScopeRef.current) {
    const socket = signalingSocketRef.current
    if (!scope || socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(scopedClientMessage(scope, 'peer-ready', {})))
    setSignalingStatus('recovering')
    return true
  }
  function createPlayerPeerConnection(scope: AuthenticatedMessage) {
    const earlyCandidates = pendingIceCandidatesRef.current.splice(0)
    closePlayerPeerConnection(false, false)
    pendingIceCandidatesRef.current.push(...earlyCandidates)
    const peer = new RTCPeerConnection(webRtcConfiguration(import.meta.env.VITE_WEBRTC_STUN_URLS))
    peerConnectionRef.current = peer
    peerScopeRef.current = scope
    setWebRtcConnectionState(peer.connectionState)
    setIceConnectionState(peer.iceConnectionState)
    peer.onicecandidate = event => {
      try {
        sendPlayerWebRtcMessage(scope, 'ice-candidate', event.candidate ? { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex } : { candidate: null, sdpMid: null, sdpMLineIndex: null })
      } catch { setSignalingStatus('error') }
    }
    peer.onconnectionstatechange = () => {
      if (peer !== peerConnectionRef.current) return
      setWebRtcConnectionState(peer.connectionState)
      if (peer.connectionState === 'connected') {
        clearDisconnectGraceTimer()
      } else if (peer.connectionState === 'disconnected' && disconnectGraceTimerRef.current === null) {
        disconnectGraceTimerRef.current = window.setTimeout(() => {
          disconnectGraceTimerRef.current = null
          if (peer !== peerConnectionRef.current || peer.connectionState !== 'disconnected') return
          const scopeForRetry = signalingScopeRef.current
          closePlayerPeerConnection(true, false)
          try { requestFreshPlayerOffer(scopeForRetry) } catch { setSignalingStatus('error') }
        }, WEBRTC_DISCONNECT_GRACE_MS)
      } else if (peer.connectionState === 'failed') {
        const scopeForRetry = signalingScopeRef.current
        closePlayerPeerConnection(true, false)
        try { requestFreshPlayerOffer(scopeForRetry) } catch { setSignalingStatus('error') }
      }
    }
    peer.oniceconnectionstatechange = () => { if (peer === peerConnectionRef.current) setIceConnectionState(peer.iceConnectionState) }
    peer.ontrack = event => {
      if (peer !== peerConnectionRef.current || event.track.kind !== 'video') return
      const stream = event.streams[0] ?? new MediaStream([event.track])
      setLiveStreams(current => {
        const previous = current.get(scope.liveSourceId)
        if (previous && previous !== stream) previous.getTracks().forEach(track => track.stop())
        return new Map(current).set(scope.liveSourceId, stream)
      })
      setHasRemoteVideoTrack(true)
      event.track.onended = () => {
        if (peer !== peerConnectionRef.current) return
        setHasRemoteVideoTrack(false)
      }
    }
    return peer
  }
  async function acceptOffer(scope: AuthenticatedMessage, sdp: string) {
    const peer = createPlayerPeerConnection(scope)
    await peer.setRemoteDescription({ type: 'offer', sdp })
    await flushIceCandidates(peer, pendingIceCandidatesRef.current)
    const answer = await peer.createAnswer()
    if (peer !== peerConnectionRef.current) return
    await peer.setLocalDescription(answer)
    if (!peer.localDescription?.sdp) throw new Error('Answer SDP was not created')
    sendPlayerWebRtcMessage(scope, 'answer', { sdp: peer.localDescription.sdp })
  }

  useEffect(() => {
    if (!device || !liveSession || new Date(liveSession.expiresAt).getTime() <= Date.now()) {
      closePlayerPeerConnection()
      signalingScopeRef.current = null
      signalingSocketRef.current?.close(1000, 'lease-unavailable')
      signalingSocketRef.current = null
      setSignalingStatus('idle')
      return
    }
    const activeDevice = device
    const activeSession = liveSession
    let stopped = false
    let sessionEnded = false
    let retryTimer = 0
    let retryAttempt = 0
    let socket: WebSocket | null = null
    const leaseIsCurrent = () => {
      const current = liveSessionRef.current
      return current?.sessionId === activeSession.sessionId && new Date(current.expiresAt).getTime() > Date.now()
    }
    const retry = () => {
      window.clearTimeout(retryTimer)
      if (!stopped && !sessionEnded && leaseIsCurrent()) retryTimer = window.setTimeout(connect, recoveryDelayMs(retryAttempt++))
    }
    function connect() {
      if (stopped) return
      setSignalingStatus('connecting')
      try { socket = new WebSocket(activeSession.signalingUrl) } catch { setSignalingStatus('error'); retry(); return }
      signalingSocketRef.current = socket
      socket.addEventListener('open', () => { if (!stopped && signalingSocketRef.current === socket) socket?.send(JSON.stringify({ version: SIGNALING_VERSION, type: 'auth', role: 'player', deviceId: activeDevice.id, deviceToken: activeDevice.token, sessionId: activeSession.sessionId })) })
      socket.addEventListener('message', (event) => { void (async () => {
        if (typeof event.data !== 'string' || stopped || signalingSocketRef.current !== socket) return
        const message = parseServerSignalingMessage(event.data)
        if (!message) return setSignalingStatus('error')
        if (message.type === 'authenticated' && message.role === 'player' && message.sessionId === activeSession.sessionId) {
          const peer = peerConnectionRef.current
          const peerScope = peerScopeRef.current
          const samePeerSession = peerScope?.sessionId === message.sessionId && peerScope.liveSourceId === message.liveSourceId && peerScope.targetDeviceId === message.targetDeviceId && peerScope.generation === message.generation
          const preservePeer = samePeerSession && (peer?.connectionState === 'connected' || (peer?.connectionState === 'disconnected' && disconnectGraceTimerRef.current !== null))
          if (!preservePeer) closePlayerPeerConnection()
          signalingScopeRef.current = message
          setSignalingStatus('connected')
          retryAttempt = 0
          if (!preservePeer) requestFreshPlayerOffer(message as AuthenticatedMessage)
        } else if (message.type === 'offer' && !safeMode && !videosDisabled) {
          const scope = signalingScopeRef.current
          if (scope && message.sessionId === scope.sessionId && message.generation === scope.generation) await acceptOffer(scope, message.payload.sdp)
        } else if (message.type === 'ice-candidate' && !safeMode && !videosDisabled) {
          const scope = signalingScopeRef.current
          if (scope && message.sessionId === scope.sessionId && message.generation === scope.generation) await addOrQueueIceCandidate(peerConnectionRef.current, message.payload.candidate === null ? null : { candidate: message.payload.candidate, sdpMid: message.payload.sdpMid, sdpMLineIndex: message.payload.sdpMLineIndex }, pendingIceCandidatesRef.current)
        }
        else if (message.type === 'session-ended') { sessionEnded = true; closePlayerPeerConnection(); signalingScopeRef.current = null; setSignalingStatus('ended') }
        else if (message.type === 'error') { closePlayerPeerConnection(); setSignalingStatus('error') }
      })().catch(() => { closePlayerPeerConnection(false); setWebRtcConnectionState('failed') }) })
      socket.addEventListener('close', () => {
        if (signalingSocketRef.current !== socket) return
        const peer = peerConnectionRef.current
        const retainMediaPeer = leaseIsCurrent() && (peer?.connectionState === 'connected' || peer?.connectionState === 'disconnected')
        if (!retainMediaPeer) closePlayerPeerConnection()
        signalingScopeRef.current = null
        signalingSocketRef.current = null
        if (!stopped && !sessionEnded) setSignalingStatus('disconnected')
        retry()
      })
      socket.addEventListener('error', () => setSignalingStatus('error'))
    }
    connect()
    return () => { stopped = true; window.clearTimeout(retryTimer); closePlayerPeerConnection(); signalingScopeRef.current = null; socket?.close(1000, 'lease-changed'); if (signalingSocketRef.current === socket) signalingSocketRef.current = null }
  }, [device, liveSession?.sessionId, liveSession?.signalingUrl])

  async function pair(event: FormEvent) {
    event.preventDefault(); if (!supabase || !pin.trim()) return
    setStatus('Pairing…')
    const { data, error } = await supabase.rpc('claim_pairing_pin', { pin_value: pin.trim(), device_name: `Pi display ${new Date().toLocaleTimeString()}`, viewport_width: innerWidth, viewport_height: innerHeight })
    if (error) return setStatus(error.message)
    const claimed = data as { id: string; token: string }
    localStorage.setItem('videowall-device', JSON.stringify(claimed)); setDevice(claimed)
  }

  const geometryVersion = scene ? sceneGeometryVersion(scene) : null
  const v2Contract = scene && geometryVersion === 2 ? validateV2SceneRender(scene, virtualWallGeometry, device?.id) : null
  const currentVirtualRegion = device && virtualWallGeometry?.status === 'valid' ? virtualWallGeometry.devices.find(region => region.deviceId === device.id) : undefined
  const currentDevice = device ? wallDevices.find(candidate => candidate.id === device.id) : undefined
  const geometryRows = geometryDebugRows(scene, virtualWallGeometry, v2Contract, currentVirtualRegion, { width: innerWidth, height: innerHeight })
  const debugPanel = debug ? <PlayerDebugOverlay device={device} deviceName={currentDevice?.name ?? null} wallId={currentDevice?.wall_id ?? null} scene={scene} playlistRuntime={playlistRuntime} status={status} geometryRows={geometryRows} signalingStatus={signalingStatus} liveRows={liveDebugRows(scene?.layers ?? [], liveSessions.map(lease => lease.liveSourceId), liveSourceStates, liveStreams, liveSourceDiagnostics)} mediaRows={mediaDebugRows(scene?.layers ?? [], mediaStates)} health={playerHealthSummary({ scene, contract: v2Contract, status, signaling: signalingStatus })} webRtcConnectionState={webRtcConnectionState} iceConnectionState={iceConnectionState} /> : null
  if (!isConfigured) return <main className="player-message">This player needs Supabase configuration.</main>
  if (!device) return <>{debugPanel}<main className="pairing"><form onSubmit={pair}><p className="eyebrow">SCREENMESH PLAYER</p><h1>Pair this screen</h1><p>Enter the one-time PIN from the dashboard.</p><input autoFocus inputMode="numeric" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} placeholder="000000" /><button>Connect display</button><small>{status}</small></form></main></>
  if (safeMode) return <>{debugPanel}<main className="player-message" style={{ background: '#070a12', color: '#9bf6d2', fontFamily: 'monospace', textAlign: 'center' }}><div><strong>ScreenMesh player base is working</strong><br /><small>Scene media is intentionally disabled for this diagnostic.</small></div></main></>
  const liveRuntimes = liveSessions.map(lease => <PlayerLiveSession key={lease.sessionId} device={device} lease={lease} disabled={safeMode || videosDisabled} diagnosticsEnabled={debug} onStream={registerLiveStream} onRemove={removeLiveStream} onStatus={debug ? setLiveSourceStatus : ignoreLiveSourceStatus} onDiagnostic={debug ? setLiveSourceDiagnostic : ignoreLiveSourceDiagnostic} />)
  if (scene && v2Contract?.status === 'invalid') return <>{liveRuntimes}<main className="player-message">V2 geometry unavailable: {v2Contract.reason}</main>{debugPanel}</>
  return scene ? <>{liveRuntimes}<ScenePreview scene={scene} player deviceId={device.id} devices={wallDevices} virtualWallGeometry={virtualWallGeometry} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} videosDisabled={videosDisabled} rawVideos={rawVideos} liveStreams={liveStreams} onMediaStateChange={debug ? setMediaStatus : undefined} onLivePresentationFps={debug ? setLivePresentationFps : undefined} /><PlaylistLoadingOverlay runtime={playlistRuntime} scene={playlistLoadingScene} deviceId={device.id} devices={wallDevices} virtualWallGeometry={virtualWallGeometry} videosDisabled={videosDisabled} rawVideos={rawVideos} liveStreams={liveStreams} serverEpochOffsetMs={serverEpochOffsetMs} />{debugPanel}</> : <>{liveRuntimes}<main className="player-message">{status}</main>{debugPanel}</>
}
