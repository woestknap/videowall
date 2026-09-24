import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isConfigured, supabase } from '../lib/supabase'
import type { Device, Scene, SceneLayer } from '../types'
import { ScenePreview } from '../rendering/ScenePreview'
import { parseServerSignalingMessage, scopedClientMessage, SIGNALING_VERSION, type AuthenticatedMessage, type LiveSessionLease } from '../signalingProtocol'

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
  const [wallDevices, setWallDevices] = useState<Device[]>([])
  const [sceneStartedAtMs, setSceneStartedAtMs] = useState(0)
  const [liveSession, setLiveSession] = useState<LiveSessionLease | null>(null)
  const [signalingStatus, setSignalingStatus] = useState('idle')
  const signalingSocketRef = useRef<WebSocket | null>(null)

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
    const client = supabase
    const refresh = async () => {
      const { data, error } = await client.rpc('get_player_state', { requested_device_id: device.id, requested_token: device.token })
      if (error) return setStatus('Connection issue — retrying…')
      if (data?.scene) setScene({ ...data.scene, layers: data.scene.layers as SceneLayer[] })
      else setScene(null)
      if (data?.devices) setWallDevices(data.devices as Device[])
      if (data?.scene_started_at) setSceneStartedAtMs(new Date(data.scene_started_at).getTime())
      const discovered = data?.live_session as LiveSessionLease | null | undefined
      setLiveSession(discovered && new Date(discovered.expiresAt).getTime() > Date.now() ? discovered : null)
      setStatus('Connected')
      await client.rpc('player_heartbeat', { requested_device_id: device.id, requested_token: device.token, viewport_width: innerWidth, viewport_height: innerHeight })
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(timer)
  }, [device])

  useEffect(() => {
    if (!device || !liveSession || new Date(liveSession.expiresAt).getTime() <= Date.now()) {
      signalingSocketRef.current?.close(1000, 'lease-unavailable')
      signalingSocketRef.current = null
      setSignalingStatus('idle')
      return
    }
    let stopped = false
    let retryTimer = 0
    let socket: WebSocket | null = null
    const connect = () => {
      if (stopped) return
      setSignalingStatus('connecting')
      try { socket = new WebSocket(liveSession.signalingUrl) } catch { setSignalingStatus('error'); return }
      signalingSocketRef.current = socket
      socket.addEventListener('open', () => socket?.send(JSON.stringify({ version: SIGNALING_VERSION, type: 'auth', role: 'player', deviceId: device.id, deviceToken: device.token, sessionId: liveSession.sessionId })))
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        const message = parseServerSignalingMessage(event.data)
        if (!message) return setSignalingStatus('error')
        if (message.type === 'authenticated' && message.role === 'player' && message.sessionId === liveSession.sessionId) {
          setSignalingStatus('connected')
          socket?.send(JSON.stringify(scopedClientMessage(message as AuthenticatedMessage, 'peer-ready', {})))
        } else if (message.type === 'session-ended') setSignalingStatus('ended')
        else if (message.type === 'error') setSignalingStatus('error')
      })
      socket.addEventListener('close', () => {
        if (signalingSocketRef.current === socket) signalingSocketRef.current = null
        if (!stopped) retryTimer = window.setTimeout(connect, 4000)
      })
      socket.addEventListener('error', () => setSignalingStatus('error'))
    }
    connect()
    return () => { stopped = true; window.clearTimeout(retryTimer); socket?.close(1000, 'lease-changed'); if (signalingSocketRef.current === socket) signalingSocketRef.current = null }
  }, [device, liveSession?.sessionId, liveSession?.signalingUrl])

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
  return scene ? <><ScenePreview scene={scene} player deviceId={device.id} devices={wallDevices} serverEpochOffsetMs={serverEpochOffsetMs} sceneStartedAtMs={sceneStartedAtMs} videosDisabled={videosDisabled} rawVideos={rawVideos} />{debug && <pre className="player-debug">{`device: ${device.id}\nscene: ${scene.name}\nlayers: ${scene.layers.length}\nselected for scene: ${!scene.device_ids?.length || scene.device_ids.includes(device.id)}\nstatus: ${status}\nsignaling: ${signalingStatus}\nvideos disabled: ${videosDisabled}\nraw video: ${rawVideos}`}</pre>}</> : <main className="player-message">{status}{debug && <small> · signaling: {signalingStatus}</small>}</main>
}
